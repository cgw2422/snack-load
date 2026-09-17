import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { can, requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'
import type { DeliveryChannel, DeliveryStatus } from '@/generated/prisma/client'
import { getReceiptDocument } from '@/server/documents/receiptDocument'
import { getCreditDocument } from '@/server/documents/creditDocument'
import type { ReceiptDocument } from '@/server/documents/types'
import { receiptFileName, renderReceiptPdf } from '@/server/documents/receiptPdf'
import { renderReceiptEmail, renderReceiptSms } from '@/server/documents/receiptMessage'
import { emailProvider, smsProvider } from '@/server/messaging'
import { createShareLink, shareUrlFor, type ShareTarget } from './shareLink.service'

/**
 * Getting the receipt to the store (spec §25).
 *
 * Every attempt is logged — sent or failed, by whom, to where, and what the
 * provider said. Two rules shape the whole file:
 *
 *  1. A delivery failure never touches the sale. The money moved at the
 *     counter; whether the email landed is a separate fact, and rolling back a
 *     posted transaction because an SMTP server was down would be a far worse
 *     bug than an undelivered receipt (docs/02 §A5).
 *  2. Nothing here is tied to a vendor. The provider interfaces in
 *     `src/server/messaging` are the seam, so swapping Postmark for SES, or
 *     Twilio for anything else, is a new adapter and a config change.
 */

export type DeliveryResult = {
  deliveryId: string
  status: DeliveryStatus
  destination: string | null
  /** Set when the send failed. The caller shows it; the sale is untouched. */
  failureReason: string | null
  shareUrl?: string
}

/**
 * Which document is being delivered. A receipt and a credit memo travel the
 * same channels, so the whole file is written against this rather than a sale
 * id (spec §10).
 */
export type DocumentRef = { kind: 'sale'; id: string } | { kind: 'creditMemo'; id: string }

function shareTarget(ref: DocumentRef): ShareTarget {
  return ref.kind === 'sale'
    ? { kind: 'sale', saleId: ref.id }
    : { kind: 'creditMemo', creditMemoId: ref.id }
}

function documentColumns(ref: DocumentRef) {
  return ref.kind === 'sale'
    ? { saleId: ref.id, creditMemoId: null }
    : { saleId: null, creditMemoId: ref.id }
}

/** Loads whichever document the reference names, with the same permissions. */
export async function loadDocument(
  ctx: AuthContext,
  ref: DocumentRef,
  options: { includeSignatureImage?: boolean } = {},
): Promise<ReceiptDocument> {
  return ref.kind === 'sale'
    ? getReceiptDocument(ctx, ref.id, options)
    : getCreditDocument(ctx, ref.id)
}

/** A bare log entry, for channels with nothing to send (print, download). */
export async function recordDelivery(
  ctx: AuthContext,
  input: {
    document: DocumentRef
    channel: DeliveryChannel
    status: DeliveryStatus
    destination?: string | null
    provider?: string | null
    providerMessageId?: string | null
    failureReason?: string | null
    shareLinkId?: string | null
  },
): Promise<string> {
  const row = await db(ctx).receiptDelivery.create({
    data: {
      organizationId: ctx.organizationId,
      ...documentColumns(input.document),
      channel: input.channel,
      destination: input.destination ?? null,
      status: input.status,
      provider: input.provider ?? null,
      providerMessageId: input.providerMessageId ?? null,
      failureReason: input.failureReason ?? null,
      sentByUserId: ctx.userId,
      shareLinkId: input.shareLinkId ?? null,
      completedAt: input.status === 'QUEUED' ? null : new Date(),
    },
    select: { id: true },
  })
  return row.id
}

/**
 * Emails a receipt, with the PDF attached and a share link in the body.
 *
 * The link matters as much as the attachment: a store that loses the email can
 * still open the receipt, and a phone that will not open a PDF attachment will
 * open a web page.
 */
export async function emailReceipt(
  ctx: AuthContext,
  input: { document: DocumentRef; to?: string | null; message?: string | null },
): Promise<DeliveryResult> {
  requirePermission(ctx, 'receipt:send')

  const doc = await loadDocument(ctx, input.document, { includeSignatureImage: true })
  const to = (input.to ?? doc.billTo.email ?? '').trim()
  if (!to) {
    throw conflict(
      `${doc.billTo.name} has no email address on file. Type one in, or add it to the account.`,
    )
  }

  const link = await createShareLink(ctx, shareTarget(input.document))
  const shareUrl = shareUrlFor(link.token)
  const pdf = await renderReceiptPdf(doc, 'full')
  const body = renderReceiptEmail(doc, { shareUrl, note: input.message ?? null })

  const provider = emailProvider()
  const sent = await provider.send({
    to,
    subject: body.subject,
    text: body.text,
    html: body.html,
    replyTo: doc.issuer.email ?? undefined,
    attachments: [
      { fileName: receiptFileName(doc), contentType: 'application/pdf', content: pdf },
    ],
  })

  const deliveryId = await recordDelivery(ctx, {
    document: input.document,
    channel: 'EMAIL',
    destination: to,
    status: sent.ok ? 'SENT' : 'FAILED',
    provider: provider.name,
    providerMessageId: sent.ok ? sent.messageId : null,
    failureReason: sent.ok ? null : sent.error,
    shareLinkId: link.id,
  })

  if (sent.ok && input.document.kind === 'sale') {
    await db(ctx).receipt.updateMany({
      where: { saleId: input.document.id },
      data: { emailedAt: new Date() },
    })
  }

  return {
    deliveryId,
    status: sent.ok ? 'SENT' : 'FAILED',
    destination: to,
    failureReason: sent.ok ? null : sent.error,
    shareUrl,
  }
}

/**
 * Texts a link to the receipt. A PDF is not attached: an MMS attachment is
 * expensive, unreliable across carriers, and unreadable on half the phones a
 * store clerk owns. The link opens the same document in a browser.
 */
export async function textReceipt(
  ctx: AuthContext,
  input: { document: DocumentRef; to?: string | null },
): Promise<DeliveryResult> {
  requirePermission(ctx, 'receipt:send')

  const doc = await loadDocument(ctx, input.document)
  const to = normalizePhone(input.to ?? doc.billTo.phone ?? '')
  if (!to) {
    throw conflict(
      `${doc.billTo.name} has no mobile number on file. Type one in, or add it to the account.`,
    )
  }

  const link = await createShareLink(ctx, shareTarget(input.document))
  const shareUrl = shareUrlFor(link.token)

  const provider = smsProvider()
  const sent = await provider.send({ to, body: renderReceiptSms(doc, shareUrl) })

  const deliveryId = await recordDelivery(ctx, {
    document: input.document,
    channel: 'SMS',
    destination: to,
    status: sent.ok ? 'SENT' : 'FAILED',
    provider: provider.name,
    providerMessageId: sent.ok ? sent.messageId : null,
    failureReason: sent.ok ? null : sent.error,
    shareLinkId: link.id,
  })

  if (sent.ok && input.document.kind === 'sale') {
    await db(ctx).receipt.updateMany({
      where: { saleId: input.document.id },
      data: { textedAt: new Date() },
    })
  }

  return {
    deliveryId,
    status: sent.ok ? 'SENT' : 'FAILED',
    destination: to,
    failureReason: sent.ok ? null : sent.error,
    shareUrl,
  }
}

/** Mints a link for the share sheet to copy, without sending anything. */
export async function shareLinkForReceipt(
  ctx: AuthContext,
  document: DocumentRef,
): Promise<{ shareUrl: string }> {
  requirePermission(ctx, 'receipt:send')

  // Resolve through the document assembler so the same permission and tenant
  // checks apply as everywhere else.
  await loadDocument(ctx, document)
  const link = await createShareLink(ctx, shareTarget(document))
  const shareUrl = shareUrlFor(link.token)

  await recordDelivery(ctx, {
    document,
    channel: 'LINK',
    status: 'SENT',
    destination: null,
    shareLinkId: link.id,
  })

  return { shareUrl }
}

export type DeliveryRow = {
  id: string
  channel: DeliveryChannel
  destination: string | null
  status: DeliveryStatus
  provider: string | null
  failureReason: string | null
  sentByName: string | null
  attemptedAt: string
}

/** The delivery history shown under a document. */
export async function listDeliveries(
  ctx: AuthContext,
  document: DocumentRef,
): Promise<DeliveryRow[]> {
  if (document.kind === 'sale') {
    // Reading the sale through the document assembler would be wasteful here,
    // so check the same two permissions it does.
    const sale = await db(ctx).sale.findFirst({
      where: { id: document.id },
      select: { soldByUserId: true },
    })
    if (!sale) throw notFound('That receipt')
    if (!can(ctx, 'sale:read') && sale.soldByUserId !== ctx.userId) throw notFound('That receipt')
  } else {
    const memo = await db(ctx).creditMemo.findFirst({
      where: { id: document.id },
      select: { id: true },
    })
    if (!memo) throw notFound('That credit memo')
  }

  const rows = await db(ctx).receiptDelivery.findMany({
    where: documentColumns(document).saleId
      ? { saleId: document.id }
      : { creditMemoId: document.id },
    orderBy: { attemptedAt: 'desc' },
    select: {
      id: true, channel: true, destination: true, status: true, provider: true,
      failureReason: true, attemptedAt: true,
      sentBy: { select: { firstName: true, lastName: true } },
    },
  })

  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    destination: row.destination,
    status: row.status,
    provider: row.provider,
    failureReason: row.failureReason,
    sentByName: row.sentBy ? `${row.sentBy.firstName} ${row.sentBy.lastName}`.trim() : null,
    attemptedAt: row.attemptedAt.toISOString(),
  }))
}

/**
 * Keeps digits and a leading +. Deliberately not full E.164 validation: that
 * belongs to the provider, which knows the country and will reject what it
 * cannot route, and a half-right regex here would only reject valid numbers.
 */
function normalizePhone(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const digits = trimmed.replace(/[^\d]/g, '')
  if (digits.length < 7) return ''
  return trimmed.startsWith('+') ? `+${digits}` : digits
}
