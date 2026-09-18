import { randomUUID } from 'node:crypto'
import { Prisma } from '@/generated/prisma/client'
import type { SyncErrorCategory, SyncStatus } from '@/generated/prisma/enums'
import type { TenantDb, TenantTx } from '@/server/db/tenant'
import type { EntityType } from '../mapping'

/**
 * The sync queue (docs/08 §4).
 *
 * A job is enqueued in the **same transaction as the document it describes**,
 * so a sale that committed always has its job and a sale that rolled back never
 * has one. Nothing here talks to Intuit; the worker does that, later, on its
 * own schedule. That separation is the whole reason an Intuit outage cannot
 * stop a runner from selling.
 *
 * `SyncJob` is the one reliability mechanism. `OutboxEvent` already existed for
 * general domain events and is left alone rather than grown a second retry
 * loop that would drift from this one (§4).
 */

export type Operation = 'CREATE' | 'UPDATE' | 'VOID' | 'APPLY_CREDIT' | 'REFUND'

export type QueueClient = Pick<TenantDb | TenantTx, 'syncJob'>

/** Enqueue, or wake an existing job for the same document. */
export async function enqueue(
  prisma: QueueClient,
  organizationId: string,
  input: {
    entityType: EntityType
    localId: string
    operation: Operation
    payload?: Prisma.InputJsonObject
    /** Run no earlier than this. Used to space a follow-up behind its parent. */
    availableAt?: Date
    /**
     * Mints a fresh request id. **Only** for a human asking to re-send a
     * document that already synced.
     *
     * A retry must never do this — the whole point of the id is that a retry
     * lands on the document the lost attempt created. But a *re-sync* is a
     * different intent, and reusing the id that created the document would make
     * Intuit replay the original create response and silently do nothing.
     */
    rotateRequestId?: boolean
  },
): Promise<{ id: string; requestId: string }> {
  const availableAt = input.availableAt ?? new Date()

  /**
   * The request id is minted HERE, once, and never again for this job.
   *
   * It is sent to Intuit as `requestid`, and Intuit replays the original
   * response for a repeated one. Minting it per attempt instead would mean a
   * retry after a lost response creates a second document — which is the exact
   * failure §5 exists to prevent.
   */
  const job = await prisma.syncJob.upsert({
    where: {
      organizationId_provider_entityType_localId_operation: {
        organizationId,
        provider: 'QUICKBOOKS_ONLINE',
        entityType: input.entityType,
        localId: input.localId,
        operation: input.operation,
      },
    },
    create: {
      organizationId,
      provider: 'QUICKBOOKS_ONLINE',
      entityType: input.entityType,
      localId: input.localId,
      operation: input.operation,
      requestId: randomUUID(),
      status: 'PENDING',
      nextAttemptAt: availableAt,
      payloadJson: input.payload ?? {},
    },
    // A re-enqueue wakes the job. It does NOT mint a new request id: if the
    // first attempt already reached QuickBooks, this attempt must land on the
    // same document rather than beside it.
    update: {
      status: 'PENDING',
      nextAttemptAt: availableAt,
      blockedOnJobId: null,
      lastError: null,
      errorCode: null,
      errorCategory: null,
      ...(input.rotateRequestId ? { requestId: randomUUID() } : {}),
      ...(input.payload ? { payloadJson: input.payload } : {}),
    },
    select: { id: true, requestId: true },
  })

  return job
}

/**
 * How long a worker may hold a job before another may take it (docs/08 §19).
 *
 * Generous relative to a QuickBooks call, because reclaiming a job that is
 * merely slow costs a wasted round trip, while never reclaiming one costs a
 * document that silently never syncs.
 */
export const LEASE_SECONDS = 300

/**
 * Claims one job for this worker, atomically (docs/08 §19).
 *
 * One `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`. The
 * inner select takes a row lock; `SKIP LOCKED` means a second worker walks past
 * it to the next free job rather than waiting. Two workers therefore never hold
 * the same job, and a busy queue does not serialise itself. Same discipline as
 * the ledger's balance rows, for the same reason — the alternative here is a
 * duplicate invoice.
 *
 * Eligible jobs are the queued ones **and** any whose lease has expired: a
 * worker can be killed mid-call, and a job nobody will ever pick up again is
 * worse than one attempted twice. Reclaiming is safe precisely because the
 * request id stays with the job, so a second attempt lands on the document the
 * first one created rather than beside it.
 */
export async function claimNext(
  prisma: { $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T> },
  organizationId: string,
  now = new Date(),
  leaseOwner = 'inline',
): Promise<{ id: string } | null> {
  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000)

  const rows = await prisma.$queryRaw<{ id: string; reclaimed: boolean }[]>(Prisma.sql`
    UPDATE sync_job
       SET status = 'IN_PROGRESS',
           attempts = attempts + 1,
           last_attempted_at = ${now},
           lease_owner = ${leaseOwner},
           lease_expires_at = ${leaseUntil},
           reclaimed_count = reclaimed_count
             + CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END
     WHERE id = (
       SELECT id
         FROM sync_job
        WHERE organization_id = ${organizationId}
          AND (
            (status IN ('PENDING', 'RETRYING') AND next_attempt_at <= ${now})
            -- Abandoned by a worker that did not come back.
            OR (status = 'IN_PROGRESS' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${now})
          )
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING id, (reclaimed_count > 0) AS reclaimed
  `)
  return rows[0] ? { id: rows[0].id } : null
}

/**
 * Jobs stuck IN_PROGRESS past their lease, across every organization.
 *
 * Reported rather than silently reclaimed, so "the worker died on Tuesday" is
 * something a person can see rather than something that merely resolves itself
 * five minutes later with no trace.
 */
export async function countExpiredLeases(
  prisma: { $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T> },
  organizationId: string,
  now = new Date(),
): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count
      FROM sync_job
     WHERE organization_id = ${organizationId}
       AND status = 'IN_PROGRESS'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= ${now}
  `)
  return Number(rows[0]?.count ?? 0)
}

/**
 * Backoff with jitter.
 *
 * Doubling from thirty seconds, capped at an hour. The jitter matters when a
 * whole route's worth of jobs fail together against a rate limit: without it
 * they would all come back at the same instant and fail together again.
 */
export function backoffSeconds(attempts: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.min(retryAfterSeconds, MAX_BACKOFF_SECONDS)
  const base = Math.min(30 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_SECONDS)
  // The cap applies AFTER the jitter, not before: jitter of up to 1.25x on an
  // already-capped delay would push it past the ceiling it exists to enforce.
  return Math.min(Math.round(base * (0.75 + Math.random() * 0.5)), MAX_BACKOFF_SECONDS)
}

const MAX_BACKOFF_SECONDS = 3600

/** After this many tries a transient failure stops being called transient. */
export const MAX_ATTEMPTS = 8

export type JobOutcome =
  | { status: 'SYNCED'; sourceHash?: string }
  | {
      status: 'RETRYING' | 'NEEDS_ATTENTION' | 'FAILED'
      category: SyncErrorCategory
      message: string
      code?: string
      retryAfterSeconds?: number
    }
  | { status: 'BLOCKED_DEPENDENCY'; blockedOnJobId: string | null; message: string }

export async function finish(
  prisma: QueueClient,
  jobId: string,
  attempts: number,
  outcome: JobOutcome,
): Promise<SyncStatus> {
  if (outcome.status === 'SYNCED') {
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: 'SYNCED',
        completedAt: new Date(),
        lastError: null,
        errorCode: null,
        errorCategory: null,
        blockedOnJobId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(outcome.sourceHash ? { sourceHash: outcome.sourceHash } : {}),
      },
    })
    return 'SYNCED'
  }

  if (outcome.status === 'BLOCKED_DEPENDENCY') {
    // Deliberately NOT rescheduled. A blocked job is released by the job it
    // waits for, so an invoice whose customer is unmapped does not spend the
    // afternoon asking QuickBooks the same impossible question (§4).
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: 'BLOCKED_DEPENDENCY',
        blockedOnJobId: outcome.blockedOnJobId,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCategory: 'DEPENDENCY',
        lastError: outcome.message,
      },
    })
    return 'BLOCKED_DEPENDENCY'
  }

  const exhausted = outcome.status === 'RETRYING' && attempts >= MAX_ATTEMPTS
  const status: SyncStatus = exhausted ? 'NEEDS_ATTENTION' : outcome.status

  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCategory: outcome.category,
      errorCode: outcome.code ?? null,
      lastError: exhausted
        ? `${outcome.message} (gave up after ${attempts} attempts)`
        : outcome.message.slice(0, 2000),
      ...(status === 'RETRYING'
        ? {
            nextAttemptAt: new Date(
              Date.now() + backoffSeconds(attempts, outcome.retryAfterSeconds) * 1000,
            ),
          }
        : {}),
    },
  })
  return status
}

/**
 * Wakes everything that was waiting on a job that has now synced.
 *
 * Called by the worker after each success, which is what turns
 * BLOCKED_DEPENDENCY from a dead end into a queue.
 */
export async function releaseDependents(
  prisma: QueueClient,
  jobId: string,
): Promise<number> {
  const result = await prisma.syncJob.updateMany({
    where: { blockedOnJobId: jobId, status: 'BLOCKED_DEPENDENCY' },
    data: {
      status: 'PENDING',
      blockedOnJobId: null,
      nextAttemptAt: new Date(),
      lastError: null,
      errorCategory: null,
    },
  })
  return result.count
}
