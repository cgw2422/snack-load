import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { can } from '@/server/auth/context'
import { notFound } from '@/lib/errors'
import { toAmountString } from '@/server/domain/money'
import { Prisma } from '@/generated/prisma/client'
import type { DocumentParty, ReceiptDocument } from './types'

/**
 * Exactly what a receipt needs off the sale, declared once.
 *
 * Both readers below run this same selection — one through the tenant-scoped
 * client, one through the unscoped client after a share token has established
 * the scope — and hand the row to `shape`. Prisma's client types do not survive
 * being passed around behind a common interface, so the selection is what is
 * shared rather than the client.
 */
const SELECT = {
  id: true, saleNumber: true, status: true, occurredAt: true, notes: true,
  subtotal: true, discountTotal: true, taxTotal: true, total: true,
  amountPaid: true, balanceDue: true, dueDate: true, paymentTermsCode: true,
  soldByUserId: true, billToJson: true, issuerJson: true,
  voidedAt: true, voidReason: true,
  customer: {
    select: {
      id: true, name: true, accountNumber: true, phone: true, email: true,
      addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true,
    },
  },
  soldBy: { select: { firstName: true, lastName: true } },
  voidedBy: { select: { firstName: true, lastName: true } },
  items: {
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true, productNameSnapshot: true, skuSnapshot: true, uomLabelSnapshot: true,
      quantity: true, unitPrice: true, lineSubtotal: true, discountAmount: true,
      taxAmount: true, lineTotal: true,
    },
  },
  receipt: { select: { receiptNumber: true, issuedAt: true } },
  signature: { select: { signerName: true, capturedAt: true, imagePng: true } },
  paymentAllocations: {
    select: {
      amount: true,
      payment: { select: { method: true, checkNumber: true, referenceNumber: true, status: true } },
    },
  },
} satisfies Prisma.SaleSelect

type SaleRow = Prisma.SaleGetPayload<{ select: typeof SELECT }>

const ORG_SELECT = {
  name: true, legalName: true, phone: true, email: true, logoUrl: true,
  receiptFooter: true, addressLine1: true, addressLine2: true, city: true,
  state: true, postalCode: true, currency: true, timezone: true,
} satisfies Prisma.OrganizationSelect

type OrgRow = Prisma.OrganizationGetPayload<{ select: typeof ORG_SELECT }>

/**
 * Assembles the one value every receipt renderer works from (spec §24).
 *
 * Reads the snapshots the sale carries in preference to the live store and
 * company rows. Falls back to the live rows only for sales posted before those
 * columns existed, and reports which it did, because "the customer's address"
 * and "the address on the invoice" are different facts and a distributor
 * arguing with a store needs the second one.
 */
export async function getReceiptDocument(
  ctx: AuthContext,
  saleId: string,
  options: { includeSignatureImage?: boolean } = {},
): Promise<ReceiptDocument> {
  const prisma = db(ctx)

  const [sale, organization] = await Promise.all([
    prisma.sale.findFirst({ where: { id: saleId }, select: SELECT }),
    prisma.organization.findFirstOrThrow({ where: { id: ctx.organizationId }, select: ORG_SELECT }),
  ])
  if (!sale) throw notFound('That receipt')

  // A runner without the org-wide read may still see their own sales.
  if (!can(ctx, 'sale:read') && sale.soldByUserId !== ctx.userId) throw notFound('That receipt')

  return shape(sale, organization, options.includeSignatureImage ?? false)
}

/**
 * The same document for a visitor holding a valid share link (spec §25).
 *
 * There is no session here, so there is no scope to derive from one: the token
 * already established which organization and which sale, and the caller passes
 * both. Nothing a visitor controls reaches this function — `saleId` comes from
 * the resolved link row, never from the URL — so there is no parameter to
 * tamper with. This is the fourth documented use of the unscoped client
 * (docs/04 §5).
 */
export async function getPublicReceiptDocument(
  organizationId: string,
  saleId: string,
): Promise<ReceiptDocument> {
  const [sale, organization] = await Promise.all([
    unsafeDb.sale.findFirst({ where: { id: saleId, organizationId }, select: SELECT }),
    unsafeDb.organization.findFirstOrThrow({ where: { id: organizationId }, select: ORG_SELECT }),
  ])
  if (!sale) throw notFound('That receipt')

  return shape(sale, organization, true)
}

function shape(sale: SaleRow, organization: OrgRow, includeSignatureImage: boolean): ReceiptDocument {
  const storedIssuer = asParty(sale.issuerJson)
  const storedBillTo = asParty(sale.billToJson)

  const issuer: DocumentParty = storedIssuer ?? {
    name: organization.name,
    subtitle: organization.legalName,
    addressLines: addressLines(organization),
    phone: organization.phone,
    email: organization.email,
  }

  const billTo: DocumentParty = storedBillTo ?? {
    name: sale.customer.name,
    subtitle: `#${sale.customer.accountNumber}`,
    addressLines: addressLines(sale.customer),
    phone: sale.customer.phone,
    email: sale.customer.email,
  }

  const issuerExtras = asIssuerExtras(sale.issuerJson)

  return {
    kind: 'sale',
    documentId: sale.id,
    saleId: sale.id,
    saleNumber: sale.saleNumber,
    receiptNumber: sale.receipt?.receiptNumber ?? sale.saleNumber,
    status: sale.status,
    occurredAt: sale.occurredAt.toISOString(),
    issuedAt: (sale.receipt?.issuedAt ?? sale.occurredAt).toISOString(),
    dueDate: sale.dueDate?.toISOString() ?? null,
    paymentTermsCode: sale.paymentTermsCode,
    notes: sale.notes,

    issuer,
    logoUrl: issuerExtras.logoUrl ?? organization.logoUrl,
    footer: issuerExtras.footer ?? organization.receiptFooter,
    currency: organization.currency,
    timeZone: organization.timezone,

    billTo,
    customerId: sale.customer.id,
    soldByName: fullName(sale.soldBy),

    lines: sale.items.map((item) => ({
      id: item.id,
      name: item.productNameSnapshot,
      sku: item.skuSnapshot,
      uomLabel: item.uomLabelSnapshot,
      quantity: item.quantity,
      unitPrice: toAmountString(item.unitPrice),
      lineSubtotal: toAmountString(item.lineSubtotal),
      discountAmount: toAmountString(item.discountAmount),
      taxAmount: toAmountString(item.taxAmount),
      lineTotal: toAmountString(item.lineTotal),
    })),
    subtotal: toAmountString(sale.subtotal),
    discountTotal: toAmountString(sale.discountTotal),
    taxTotal: toAmountString(sale.taxTotal),
    total: toAmountString(sale.total),
    amountPaid: toAmountString(sale.amountPaid),
    balanceDue: toAmountString(sale.balanceDue),
    // A reversed payment is not money the store paid, so it does not belong on
    // the document as one.
    payments: sale.paymentAllocations
      .filter((a) => Number(a.amount) > 0 && a.payment.status !== 'REVERSED')
      .map((a) => ({
        method: a.payment.method,
        amount: toAmountString(a.amount),
        reference: a.payment.checkNumber ?? a.payment.referenceNumber,
      })),

    signature: sale.signature
      ? {
          signerName: sale.signature.signerName,
          capturedAt: sale.signature.capturedAt.toISOString(),
          imagePng: includeSignatureImage ? toBytes(sale.signature.imagePng) : null,
        }
      : null,

    // A voided sale keeps its document; saying so on the face of it is the
    // whole point. History is never silently rewritten (docs/02 §A4).
    void: sale.voidedAt
      ? {
          voidedAt: sale.voidedAt.toISOString(),
          reason: sale.voidReason,
          voidedByName: sale.voidedBy ? fullName(sale.voidedBy) : null,
        }
      : null,

    headerFromSnapshot: storedIssuer !== null && storedBillTo !== null,
  }
}

function fullName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`.trim()
}

function addressLines(source: {
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  postalCode: string | null
}): string[] {
  const cityLine = [source.city, source.state].filter(Boolean).join(', ')
  return [
    source.addressLine1,
    source.addressLine2,
    [cityLine, source.postalCode].filter(Boolean).join(' '),
  ].filter((line): line is string => Boolean(line && line.trim()))
}

/** Prisma hands back `JsonValue`; nothing here trusts its shape without checking. */
function asParty(value: unknown): DocumentParty | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.name !== 'string') return null

  return {
    name: raw.name,
    subtitle: typeof raw.subtitle === 'string' ? raw.subtitle : null,
    addressLines: Array.isArray(raw.addressLines)
      ? raw.addressLines.filter((line): line is string => typeof line === 'string')
      : [],
    phone: typeof raw.phone === 'string' ? raw.phone : null,
    email: typeof raw.email === 'string' ? raw.email : null,
  }
}

function asIssuerExtras(value: unknown): { logoUrl: string | null; footer: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { logoUrl: null, footer: null }
  }
  const raw = value as Record<string, unknown>
  return {
    logoUrl: typeof raw.logoUrl === 'string' ? raw.logoUrl : null,
    footer: typeof raw.footer === 'string' ? raw.footer : null,
  }
}

function toBytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null
}
