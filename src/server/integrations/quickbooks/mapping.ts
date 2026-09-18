import { createHash } from 'node:crypto'
import type { TenantDb, TenantTx } from '@/server/db/tenant'

/**
 * `ExternalMapping` as the sync engine uses it (docs/07 §1a, docs/08 §5).
 *
 * The identity rule, restated because it is the one everything rests on: our
 * side is always the row's cuid. Never a display name, an account number, a SKU
 * or a document number — all of those are editable or re-issuable, and a
 * mapping keyed on one silently retargets when somebody renames a store.
 *
 * A mapping row is created **before** the push, not after. If the process dies
 * between sending and recording, the row and its request id are still there to
 * say what was in flight.
 */

export type MappingClient = Pick<TenantDb | TenantTx, 'externalMapping'>

export type EntityType =
  | 'Customer'
  | 'Product'
  | 'Sale'
  | 'Payment'
  | 'CreditMemo'
  | 'CreditMemoApplication'
  | 'Refund'
  | 'CogsJournalBatch'

export type Mapping = {
  id: string
  entityType: string
  localId: string
  externalId: string | null
  externalSyncToken: string | null
  status: string
  sourceHash: string | null
  lastSucceededAt: Date | null
  lastError: string | null
}

const PROVIDER = 'QUICKBOOKS_ONLINE' as const

export async function findMapping(
  prisma: MappingClient,
  entityType: EntityType,
  localId: string,
): Promise<Mapping | null> {
  return prisma.externalMapping.findFirst({
    where: { provider: PROVIDER, entityType, localId },
    select: {
      id: true, entityType: true, localId: true, externalId: true, externalSyncToken: true,
      status: true, sourceHash: true, lastSucceededAt: true, lastError: true,
    },
  })
}

/** The external id, or null if this document has never reached QuickBooks. */
export async function externalIdFor(
  prisma: MappingClient,
  entityType: EntityType,
  localId: string,
): Promise<string | null> {
  const mapping = await findMapping(prisma, entityType, localId)
  return mapping?.externalId ?? null
}

/**
 * Opens a mapping row before the push.
 *
 * Idempotent: a second call for the same document finds the existing row and
 * only records that another attempt is starting. That matters because the
 * caller may be a retry of an attempt whose response never arrived.
 */
export async function beginAttempt(
  prisma: MappingClient,
  organizationId: string,
  entityType: EntityType,
  localId: string,
): Promise<Mapping> {
  const existing = await findMapping(prisma, entityType, localId)
  if (existing) {
    await prisma.externalMapping.update({
      where: { id: existing.id },
      data: {
        status: 'IN_PROGRESS',
        lastAttemptedAt: new Date(),
        attempts: { increment: 1 },
      },
    })
    return existing
  }

  const created = await prisma.externalMapping.create({
    data: {
      organizationId,
      provider: PROVIDER,
      entityType,
      localId,
      // Null until QuickBooks answers. The row exists so a crash between
      // sending and recording still leaves a trail.
      externalId: null,
      status: 'IN_PROGRESS',
      lastAttemptedAt: new Date(),
      attempts: 1,
    },
    select: {
      id: true, entityType: true, localId: true, externalId: true, externalSyncToken: true,
      status: true, sourceHash: true, lastSucceededAt: true, lastError: true,
    },
  })
  return created
}

export async function recordSuccess(
  prisma: MappingClient,
  mappingId: string,
  result: { externalId: string; syncToken?: string | null; sourceHash: string },
): Promise<void> {
  await prisma.externalMapping.update({
    where: { id: mappingId },
    data: {
      externalId: result.externalId,
      externalSyncToken: result.syncToken ?? null,
      sourceHash: result.sourceHash,
      status: 'SYNCED',
      lastSucceededAt: new Date(),
      lastError: null,
    },
  })
}

export async function recordFailure(
  prisma: MappingClient,
  mappingId: string,
  error: { message: string; retryable: boolean },
): Promise<void> {
  await prisma.externalMapping.update({
    where: { id: mappingId },
    data: {
      status: error.retryable ? 'RETRYING' : 'NEEDS_ATTENTION',
      // Intuit's own words, kept verbatim: a paraphrase is what turns a
      // support call into an archaeology exercise.
      lastError: error.message.slice(0, 2000),
    },
  })
}

/**
 * A stable fingerprint of what we sent.
 *
 * Equal hash means QuickBooks already holds this exact document, so a re-queued
 * push is a no-op rather than a pointless write that burns a rate-limit slot
 * and bumps their SyncToken for no reason.
 *
 * Keys are sorted so that a reordered object is the same document — otherwise
 * every refactor of a payload builder would look like a change to every
 * document ever synced.
 */
export function sourceHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}
