import type { SyncErrorCategory } from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'
import { db } from '@/server/db/tenant'
import { AppError } from '@/lib/errors'
import { recordFailure, type EntityType } from '../mapping'
import { QuickBooksError, type QuickBooksClient } from '../types'
import { loadSettings, type SyncContext } from './context'
import { claimNext, enqueue, finish, releaseDependents, type Operation } from './queue'
import { DependencyNotReady, recordSuccess, SYNCERS, VOIDERS } from './syncers'

/**
 * The worker (docs/08 §4).
 *
 * The only thing in SnackLoad that talks to Intuit, and it runs entirely
 * outside the transactions that post sales. That is the property §1 asks for:
 * a runner closing a route is never waiting on Intuit, because nothing in the
 * selling path ever calls this.
 *
 * One pass drains up to `limit` jobs for one organization. It is driven by a
 * cron, by the SYNC NOW button, and by tests — all through `drain`.
 */

export type DrainResult = {
  processed: number
  synced: number
  failed: number
  blocked: number
  /** Null when there was nothing to do or no usable connection. */
  stoppedBecause: 'EMPTY' | 'LIMIT' | 'NO_CONNECTION' | 'PAUSED' | 'AUTHORIZATION' | null
}

export type DrainOptions = {
  organizationId: string
  userId?: string | null
  client: QuickBooksClient
  limit?: number
  /** Injectable so tests can drive time rather than wait for it. */
  now?: () => Date
  /**
   * Who is holding the lease. Two workers running at once each stamp their own
   * token, which is what makes "who had this when it died" answerable.
   */
  leaseOwner?: string
}

const CATEGORY: Record<string, SyncErrorCategory> = {
  TRANSIENT: 'TRANSIENT',
  VALIDATION: 'VALIDATION',
  MAPPING: 'MAPPING',
  AUTHORIZATION: 'AUTHORIZATION',
  EXTERNAL_CONFLICT: 'EXTERNAL_CONFLICT',
}

/** What each entity's dependency is, for the message a human reads. */
const DEPENDENCY_ORDER: EntityType[] = [
  'Customer',
  'Product',
  'Sale',
  'Payment',
  'CreditMemo',
  'CreditMemoApplication',
  'Refund',
  'CogsJournalBatch',
]

export async function drain(options: DrainOptions): Promise<DrainResult> {
  const { organizationId, client } = options
  const limit = options.limit ?? 50
  const now = options.now ?? (() => new Date())
  const prisma = db({ organizationId })

  const connection = await prisma.integrationConnection.findFirst({
    where: { provider: 'QUICKBOOKS_ONLINE' },
    select: { id: true, status: true, settingsJson: true },
  })
  if (!connection || connection.status !== 'CONNECTED') {
    return { processed: 0, synced: 0, failed: 0, blocked: 0, stoppedBecause: 'NO_CONNECTION' }
  }

  const settings = loadSettings(connection.settingsJson)
  if (settings.syncPaused) {
    return { processed: 0, synced: 0, failed: 0, blocked: 0, stoppedBecause: 'PAUSED' }
  }

  const ctx: SyncContext = {
    organizationId,
    userId: options.userId ?? null,
    prisma,
    client,
    settings,
    refCache: new Map(),
  }

  const result: DrainResult = { processed: 0, synced: 0, failed: 0, blocked: 0, stoppedBecause: null }
  await prisma.integrationConnection.update({
    where: { id: connection.id },
    data: { lastSyncAttemptAt: now() },
  })

  while (result.processed < limit) {
    const claimed = await claimNext(prisma, organizationId, now(), options.leaseOwner ?? 'inline')
    if (!claimed) {
      result.stoppedBecause = 'EMPTY'
      break
    }

    result.processed += 1
    const outcome = await runOne(ctx, claimed.id, now)

    if (outcome === 'SYNCED') result.synced += 1
    else if (outcome === 'BLOCKED_DEPENDENCY') result.blocked += 1
    else result.failed += 1

    /**
     * A revoked grant stops the whole pass. Every remaining job would fail the
     * same way, and hammering Intuit with calls it has already refused is how
     * an app gets rate limited on top of being disconnected.
     */
    if (outcome === 'AUTHORIZATION_LOST') {
      result.stoppedBecause = 'AUTHORIZATION'
      await prisma.integrationConnection.update({
        where: { id: connection.id },
        data: { status: 'NEEDS_REAUTH', lastError: 'QuickBooks refused the connection.' },
      })
      break
    }
  }

  if (result.synced > 0) {
    await prisma.integrationConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: now(), lastError: null },
    })
  }

  if (result.processed >= limit && result.stoppedBecause === null) result.stoppedBecause = 'LIMIT'
  return result
}

type RunOutcome = 'SYNCED' | 'BLOCKED_DEPENDENCY' | 'FAILED' | 'AUTHORIZATION_LOST'

async function runOne(ctx: SyncContext, jobId: string, now: () => Date): Promise<RunOutcome> {
  const job = await ctx.prisma.syncJob.findFirstOrThrow({
    where: { id: jobId },
    select: {
      id: true, entityType: true, localId: true, operation: true, attempts: true, requestId: true,
    },
  })

  /**
   * A void is a different operation on the same document, not a different
   * document (docs/08 §17). `VOID` reverses what QuickBooks holds; everything
   * else creates or updates it.
   */
  const entityType = job.entityType as EntityType
  const syncer = job.operation === 'VOID' ? VOIDERS[entityType] : SYNCERS[entityType]
  if (!syncer) {
    await finish(ctx.prisma, job.id, job.attempts, {
      status: 'FAILED',
      category: 'VALIDATION',
      message:
        job.operation === 'VOID'
          ? `A ${job.entityType} has no QuickBooks document to reverse.`
          : `Nothing in this build knows how to sync a ${job.entityType}.`,
    })
    return 'FAILED'
  }

  try {
    const result = await syncer(ctx, job.localId, job.requestId)

    /**
     * QuickBooks accepted the document but recorded different money. That is
     * not a success (§8). The mapping keeps the external id — the document
     * exists and re-sending would duplicate it — but the job goes to the issues
     * screen so somebody decides what the right figure is.
     */
    if (result.reconciliation) {
      await mapFailure(ctx, job, result.reconciliation.message, false)
      await log(ctx, job.id, job.attempts, 'error', result.reconciliation.message)
      await finish(ctx.prisma, job.id, job.attempts, {
        status: 'NEEDS_ATTENTION',
        category: result.reconciliation.kind,
        message: result.reconciliation.message,
      })
      return 'FAILED'
    }

    if (result.externalId !== 'NOT_APPLICABLE') {
      const mapping = await ctx.prisma.externalMapping.findFirstOrThrow({
        where: { provider: 'QUICKBOOKS_ONLINE', entityType: job.entityType, localId: job.localId },
        select: { id: true },
      })
      await recordSuccess(ctx.prisma, mapping.id, {
        externalId: result.externalId,
        syncToken: result.syncToken,
        sourceHash: result.sourceHash,
      })
    }

    await finish(ctx.prisma, job.id, job.attempts, {
      status: 'SYNCED',
      sourceHash: result.sourceHash,
    })
    await log(
      ctx,
      job.id,
      job.attempts,
      'info',
      result.externalId === 'NOT_APPLICABLE'
        ? job.operation === 'VOID'
          ? 'Nothing to reverse: this document never reached QuickBooks.'
          : 'Nothing to send: a counter payment is already recorded by its sales receipt.'
        : `${job.operation === 'VOID' ? 'Reversed' : 'Synced as'} QuickBooks ${job.entityType} ${result.externalId}.` +
            (result.taxProvenance === 'LEGACY'
              ? ' Tax detail was not recorded on this document; amounts were sent as posted.'
              : ''),
    )

    // Whatever was waiting on this can go now.
    await releaseDependents(ctx.prisma, job.id)
    return 'SYNCED'
  } catch (error) {
    return handleFailure(ctx, job, error, now)
  }
}

async function handleFailure(
  ctx: SyncContext,
  job: { id: string; entityType: string; localId: string; operation: string; attempts: number },
  error: unknown,
  now: () => Date,
): Promise<RunOutcome> {
  /**
   * A missing reference is not a failure of this document — it is this document
   * waiting its turn. The dependency is enqueued (if it is not already), this
   * job is parked against it, and nothing is sent to Intuit (§4, §5).
   */
  if (error instanceof DependencyNotReady) {
    const dependency = await enqueue(ctx.prisma, ctx.organizationId, {
      entityType: error.entityType,
      localId: error.localId,
      operation: 'CREATE',
      availableAt: now(),
    })

    await finish(ctx.prisma, job.id, job.attempts, {
      status: 'BLOCKED_DEPENDENCY',
      blockedOnJobId: dependency.id,
      message: error.message,
    })
    await log(ctx, job.id, job.attempts, 'info', `Waiting: ${error.message}`)
    return 'BLOCKED_DEPENDENCY'
  }

  const qb = error instanceof QuickBooksError ? error : classifyUnexpected(error)

  await mapFailure(ctx, job, qb.message, qb.retryable)
  await log(ctx, job.id, job.attempts, 'error', qb.message, {
    code: qb.options.code,
    detail: qb.options.detail,
    httpStatus: qb.options.httpStatus,
  })

  await finish(ctx.prisma, job.id, job.attempts, {
    status: qb.retryable ? 'RETRYING' : 'NEEDS_ATTENTION',
    category: CATEGORY[qb.category] ?? 'VALIDATION',
    message: qb.message,
    code: qb.options.code,
    retryAfterSeconds: qb.options.retryAfterSeconds,
  })

  return qb.category === 'AUTHORIZATION' ? 'AUTHORIZATION_LOST' : 'FAILED'
}

/**
 * Anything that is not a QuickBooks error is ours, and an operator must not be
 * shown the inside of it.
 *
 * A Prisma failure carries a stack, a compiled chunk path and the query that
 * broke — none of which belongs on a settings screen, and all of which an
 * operator can do nothing with. The detail goes to the server log; the issue
 * gets a sentence somebody can act on.
 */
export function classifyUnexpected(error: unknown): QuickBooksError {
  // A domain error is already a sentence written for a person.
  if (error instanceof AppError) {
    return new QuickBooksError('VALIDATION', error.message)
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    // QuickBooks handed back an id that another SnackLoad document already
    // claims. In practice that means the connection was repointed at a
    // different company, or mappings are left over from one.
    return new QuickBooksError(
      'MAPPING',
      'QuickBooks returned an id that is already mapped to another SnackLoad document. ' +
        'This usually means the connection was moved to a different QuickBooks company. ' +
        'Reconnect to the original company, or clear the old mappings before syncing again.',
      { code: error.code },
    )
  }

  console.error('[quickbooks] unexpected sync failure', error)
  return new QuickBooksError(
    'VALIDATION',
    'Something went wrong preparing this document for QuickBooks. The details are in the server log.',
  )
}

async function mapFailure(
  ctx: SyncContext,
  job: { entityType: string; localId: string },
  message: string,
  retryable: boolean,
): Promise<void> {
  const mapping = await ctx.prisma.externalMapping.findFirst({
    where: { provider: 'QUICKBOOKS_ONLINE', entityType: job.entityType, localId: job.localId },
    select: { id: true },
  })
  if (mapping) await recordFailure(ctx.prisma, mapping.id, { message, retryable })
}

/**
 * The trail a support conversation follows.
 *
 * Request and response bodies are deliberately NOT stored: they carry customer
 * addresses and, on an auth path, tokens. What is kept is the decision and
 * Intuit's own error text (docs/04 §7).
 */
async function log(
  ctx: SyncContext,
  syncJobId: string,
  attempt: number,
  level: 'info' | 'error',
  message: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await ctx.prisma.syncLog.create({
    data: {
      organizationId: ctx.organizationId,
      syncJobId,
      attempt,
      level,
      message: message.slice(0, 2000),
      ...(detail ? { responseJson: detail as Prisma.InputJsonObject } : {}),
    },
  })
}

export { DEPENDENCY_ORDER }
export type { Operation }
