import type { TenantDb, TenantTx } from '@/server/db/tenant'
import type { EntityType } from '../mapping'
import { enqueue, type Operation } from './queue'

/**
 * Where posted documents enter the queue (docs/08 §4).
 *
 * Called from inside the transaction that posts the document, so the two commit
 * or roll back together: a sale that exists always has its job, and a sale that
 * did not happen never gets one. That is the whole outbox property, and it is
 * why nothing here can fail a checkout — it writes one row to our own database
 * and does not know Intuit exists.
 *
 * `postInventoryTransaction` has no hook and never will. QuickBooks does not own
 * SnackLoad's stock (docs/07 §3), so truck loads, transfers and adjustments are
 * not accounting events as far as this integration is concerned; their cost
 * effect reaches QuickBooks once a period, as a COGS journal.
 */

export type HookClient = Pick<TenantDb | TenantTx, 'syncJob' | 'integrationConnection'>

/**
 * Queues work only for an organization that has actually connected QuickBooks.
 *
 * Otherwise every distributor who never uses the integration would accumulate a
 * job per sale forever. A connection made later backfills, so nothing is lost
 * by not queueing in advance.
 *
 * `NEEDS_REAUTH` still queues: the documents are real and the operator is going
 * to reconnect. Refusing to record them would mean a gap in their books exactly
 * across the window where something went wrong.
 */
export async function enqueueIfConnected(
  prisma: HookClient,
  organizationId: string,
  input: { entityType: EntityType; localId: string; operation: Operation },
): Promise<void> {
  const connection = await prisma.integrationConnection.findFirst({
    where: { provider: 'QUICKBOOKS_ONLINE', status: { in: ['CONNECTED', 'NEEDS_REAUTH'] } },
    select: { id: true },
  })
  if (!connection) return

  await enqueue(prisma, organizationId, input)
}

/**
 * Queues the reversal of a document that may already be in QuickBooks
 * (docs/08 §17).
 *
 * Called from inside the transaction that commits the local reversal, for the
 * same reason the create hook is: the two commit together or not at all, and
 * neither can fail a reversal that has to happen whatever Intuit is doing.
 *
 * It is enqueued even when the document has not synced yet. The void syncer
 * finds no mapping and records that there was nothing to reverse — which is
 * cheaper and more honest than trying to guess here, and leaves a trail either
 * way.
 */
export async function enqueueVoidIfConnected(
  prisma: HookClient,
  organizationId: string,
  input: { entityType: EntityType; localId: string },
): Promise<void> {
  await enqueueIfConnected(prisma, organizationId, { ...input, operation: 'VOID' })
}
