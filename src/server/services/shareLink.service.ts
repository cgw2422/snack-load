import { createHash, randomBytes } from 'node:crypto'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { env } from '@/lib/env'
import { notFound } from '@/lib/errors'

/**
 * Capability links for receipts (spec §25, docs/04 §6).
 *
 * The link IS the credential, so it is built like one:
 *
 *  - 32 bytes from the CSPRNG, base64url. Not a cuid, not the sale id, not
 *    anything a viewer could increment to reach the next store's receipt.
 *  - Stored as a sha256 digest. A dump of `receipt_share_link` hands an
 *    attacker nothing that opens a document.
 *  - One row grants exactly one document — a receipt or a credit memo, never a
 *    choice of the two. The public reader resolves the token to that document's
 *    id and asks for it only, so there is no parameter on the public route that
 *    a visitor could edit.
 *
 * **Expiry.** A receipt is a business record; a store may need last March's
 * invoice in December, and the least helpful thing a distributor can say is
 * "that link has expired, call the office". So links last `RECEIPT_LINK_DAYS`
 * (400 by default — comfortably longer than a year of quarterly disputes), and
 * a deployment that wants links to live forever sets it to 0. Anything shorter
 * trades a real, frequent inconvenience for a small theoretical gain, because
 * the token is unguessable in the first place: the risk is a forwarded link,
 * not a brute-forced one, and revocation handles that better than a clock does.
 */

const TOKEN_BYTES = 32

/** Which document a token opens. A link grants one, never a choice of two. */
export type ShareTarget =
  | { kind: 'sale'; saleId: string }
  | { kind: 'creditMemo'; creditMemoId: string }

export type ResolvedShareLink = {
  organizationId: string
  target: ShareTarget
}


export type IssuedShareLink = {
  id: string
  /** The plaintext token. Handed out once; only its digest is stored. */
  token: string
  expiresAt: Date | null
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function shareUrlFor(token: string): string {
  return `${env().APP_URL.replace(/\/$/, '')}/r/${token}`
}

export async function createShareLink(
  ctx: AuthContext,
  target: ShareTarget,
): Promise<IssuedShareLink> {
  const prisma = db(ctx)

  // Scoped: an id from another company does not resolve, so a link can only
  // ever be minted for a document the session can already read.
  if (target.kind === 'sale') {
    const sale = await prisma.sale.findFirst({ where: { id: target.saleId }, select: { id: true } })
    if (!sale) throw notFound('That receipt')
  } else {
    const memo = await prisma.creditMemo.findFirst({
      where: { id: target.creditMemoId },
      select: { id: true },
    })
    if (!memo) throw notFound('That credit memo')
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const days = env().RECEIPT_LINK_DAYS
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000) : null

  const row = await prisma.receiptShareLink.create({
    data: {
      organizationId: ctx.organizationId,
      saleId: target.kind === 'sale' ? target.saleId : null,
      creditMemoId: target.kind === 'creditMemo' ? target.creditMemoId : null,
      tokenHash: hashToken(token),
      createdByUserId: ctx.userId,
      expiresAt,
    },
    select: { id: true },
  })

  return { id: row.id, token, expiresAt }
}

/** Revokes every live link for a document — the answer to a forwarded receipt. */
export async function revokeShareLinks(ctx: AuthContext, target: ShareTarget): Promise<number> {
  const result = await db(ctx).receiptShareLink.updateMany({
    where: {
      ...(target.kind === 'sale' ? { saleId: target.saleId } : { creditMemoId: target.creditMemoId }),
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  })
  return result.count
}

/**
 * Resolves a token for the public reader.
 *
 * This is the one place the unscoped client is legitimate (docs/04 §5): there
 * is no session, so there is no organization to scope by — the token is what
 * establishes which organization's data may be read, and the caller gets back
 * exactly one document id and nothing else to vary.
 */
export async function resolveShareToken(token: string): Promise<ResolvedShareLink | null> {
  if (!token || token.length < 16 || token.length > 128) return null

  const link = await unsafeDb.receiptShareLink.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true, organizationId: true, saleId: true, creditMemoId: true,
      expiresAt: true, revokedAt: true,
    },
  })
  if (!link) return null
  if (link.revokedAt) return null
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return null

  // Best-effort telemetry; a failed counter must not stop a store reading its
  // receipt.
  await unsafeDb.receiptShareLink
    .update({
      where: { id: link.id },
      data: { lastViewedAt: new Date(), viewCount: { increment: 1 } },
    })
    .catch(() => undefined)

  const target: ShareTarget | null = link.saleId
    ? { kind: 'sale', saleId: link.saleId }
    : link.creditMemoId
      ? { kind: 'creditMemo', creditMemoId: link.creditMemoId }
      : null
  // A link row with neither document set is corrupt, not an invitation to guess.
  if (!target) return null

  return { organizationId: link.organizationId, target }
}
