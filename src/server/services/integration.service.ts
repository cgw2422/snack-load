import { Prisma } from '@/generated/prisma/client'
import type { QuickBooksEnvironment } from '@/generated/prisma/enums'
import { db } from '@/server/db/tenant'
import { unsafeDb } from '@/server/db/client'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'
import { m, toAmountString } from '@/server/domain/money'
import { env } from '@/lib/env'
import { open, safeEqual, seal } from '@/server/crypto/secretBox'
import { createQuickBooksClient } from '@/server/integrations/quickbooks/client'
import { createFakeQuickBooks } from '@/server/integrations/quickbooks/fake'
import {
  authorizeUrl,
  exchangeCode,
  newOAuthState,
  oauthConfig,
  OAuthError,
  refreshTokens,
  revokeToken,
} from '@/server/integrations/quickbooks/oauth'
import { readSettings, type QuickBooksSettings } from '@/server/integrations/quickbooks/settings'
import type { QboAccount, QuickBooksClient, TokenSet } from '@/server/integrations/quickbooks/types'
import { drain, type DrainResult } from '@/server/integrations/quickbooks/sync/worker'
import { countExpiredLeases, enqueue } from '@/server/integrations/quickbooks/sync/queue'
import { writeAudit } from './audit.service'

/**
 * The QuickBooks connection, as the rest of SnackLoad sees it (docs/08 §3).
 *
 * This file owns persistence: tokens sealed at rest, the OAuth state that makes
 * the callback safe, the refresh that has to survive rotation, and the
 * connection's status. The adapter owns Intuit; this owns our side of it.
 *
 * Nothing here ever returns a token. `describeConnection` is what the UI gets
 * and it carries realm, company name and timestamps — never a secret, not even
 * masked, because a masked token in a screenshot is still four characters of a
 * secret nobody needed to see (docs/04 §7).
 */

const PROVIDER = 'QUICKBOOKS_ONLINE' as const

/** Refresh this far before expiry rather than at it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000
/** An OAuth round trip nobody finished in ten minutes is abandoned. */
const STATE_TTL_MS = 10 * 60 * 1000

export type ConnectionView = {
  status: 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED' | 'NEEDS_REAUTH' | 'ERROR'
  environment: QuickBooksEnvironment
  companyName: string | null
  realmId: string | null
  connectedAt: Date | null
  lastSyncAt: Date | null
  lastSyncAttemptAt: Date | null
  lastError: string | null
  /** Whether the app itself has Intuit credentials configured at all. */
  available: boolean
  settings: QuickBooksSettings
  health: {
    pending: number
    retrying: number
    blocked: number
    needsAttention: number
    syncedToday: number
    /** Jobs a worker claimed and never finished. Zero, or something died. */
    staleLeases: number
  }
  /**
   * Whether the scheduled worker is doing its job — from measured state, never
   * asserted (docs/08 §18). `UNKNOWN` means it has never run here, which is an
   * honest answer and a different one from "unhealthy".
   */
  worker: {
    status: 'HEALTHY' | 'LATE' | 'STALLED' | 'UNKNOWN' | 'NOT_CONFIGURED'
    lastRunAt: Date | null
    detail: string
  }
}

const STATUS_VIEW: Record<string, ConnectionView['status']> = {
  DISCONNECTED: 'NOT_CONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  NEEDS_REAUTH: 'NEEDS_REAUTH',
  ERROR: 'ERROR',
}

export async function describeConnection(ctx: AuthContext): Promise<ConnectionView> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const connection = await prisma.integrationConnection.findFirst({
    where: { provider: PROVIDER },
    select: {
      status: true, environment: true, companyName: true, realmId: true, connectedAt: true,
      lastSyncAt: true, lastSyncAttemptAt: true, lastError: true, settingsJson: true,
      lastWorkerRunAt: true,
    },
  })

  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)

  const [pending, retrying, blocked, needsAttention, syncedToday, staleLeases] = await Promise.all([
    prisma.syncJob.count({ where: { status: { in: ['PENDING', 'IN_PROGRESS'] } } }),
    prisma.syncJob.count({ where: { status: 'RETRYING' } }),
    prisma.syncJob.count({ where: { status: 'BLOCKED_DEPENDENCY' } }),
    prisma.syncJob.count({ where: { status: { in: ['NEEDS_ATTENTION', 'FAILED'] } } }),
    prisma.syncJob.count({ where: { status: 'SYNCED', completedAt: { gte: midnight } } }),
    countExpiredLeases(prisma, ctx.organizationId),
  ])

  return {
    status: connection ? (STATUS_VIEW[connection.status] ?? 'ERROR') : 'NOT_CONNECTED',
    environment: connection?.environment ?? 'SANDBOX',
    companyName: connection?.companyName ?? null,
    realmId: connection?.realmId ?? null,
    connectedAt: connection?.connectedAt ?? null,
    lastSyncAt: connection?.lastSyncAt ?? null,
    lastSyncAttemptAt: connection?.lastSyncAttemptAt ?? null,
    lastError: connection?.lastError ?? null,
    available: oauthConfig() !== null,
    settings: readSettings(connection?.settingsJson),
    health: { pending, retrying, blocked, needsAttention, syncedToday, staleLeases },
    worker: describeWorker(connection?.lastWorkerRunAt ?? null, staleLeases),
  }
}

/**
 * Worker health from evidence, not from hope.
 *
 * The only thing we actually know is when the scheduler last swept this tenant,
 * and whether any job was claimed and abandoned. So those are what it reports,
 * and where there is no evidence it says so rather than showing a reassuring
 * green tick that means nothing (§19).
 */
const WORKER_LATE_MS = 30 * 60 * 1000
const WORKER_STALLED_MS = 3 * 60 * 60 * 1000

function describeWorker(
  lastRunAt: Date | null,
  staleLeases: number,
): ConnectionView['worker'] {
  if (!env().SYNC_WORKER_TOKEN) {
    return {
      status: 'NOT_CONFIGURED',
      lastRunAt,
      detail:
        'No scheduled worker is configured on this server, so syncing only happens when somebody presses Sync now.',
    }
  }

  if (!lastRunAt) {
    return {
      status: 'UNKNOWN',
      lastRunAt: null,
      detail: 'The scheduled worker has not run for this company yet.',
    }
  }

  const age = Date.now() - lastRunAt.getTime()

  if (staleLeases > 0) {
    return {
      status: 'STALLED',
      lastRunAt,
      detail:
        `${staleLeases} job${staleLeases === 1 ? '' : 's'} were picked up and never finished. ` +
        'They will be retried automatically on the next sweep.',
    }
  }
  if (age > WORKER_STALLED_MS) {
    return {
      status: 'STALLED',
      lastRunAt,
      detail: 'The scheduled worker has not run in hours. Check the scheduler on the host.',
    }
  }
  if (age > WORKER_LATE_MS) {
    return { status: 'LATE', lastRunAt, detail: 'The scheduled worker is running less often than expected.' }
  }
  return { status: 'HEALTHY', lastRunAt, detail: 'The scheduled worker is running on time.' }
}

// ─── connecting ──────────────────────────────────────────────────────────────

/**
 * Starts the OAuth round trip.
 *
 * The environment is chosen **here**, by a person, and written on the
 * connection before the redirect. It is never inferred from `NODE_ENV`: a
 * staging deployment pointed at a production realm is the accident §3 exists to
 * prevent, and it is not the kind of accident anyone notices quickly.
 */
export async function beginConnect(
  ctx: AuthContext,
  environment: QuickBooksEnvironment,
): Promise<string> {
  requirePermission(ctx, 'org:manage_integrations')

  const config = oauthConfig()
  if (!config) {
    throw conflict('QuickBooks is not configured on this server. Ask an administrator to add the Intuit app credentials.')
  }

  const prisma = db(ctx)
  const state = newOAuthState()

  await prisma.integrationConnection.upsert({
    where: { organizationId_provider: { organizationId: ctx.organizationId, provider: PROVIDER } },
    create: {
      organizationId: ctx.organizationId,
      provider: PROVIDER,
      status: 'CONNECTING',
      environment,
      oauthState: state,
      oauthStateIssuedAt: new Date(),
      connectedByUserId: ctx.userId,
    },
    update: {
      status: 'CONNECTING',
      environment,
      oauthState: state,
      oauthStateIssuedAt: new Date(),
      lastError: null,
    },
    select: { id: true },
  })

  return authorizeUrl(config, state)
}

export type CallbackResult = { organizationId: string; companyName: string; realmId: string }

/**
 * Completes the round trip.
 *
 * Runs on the unscoped client because it happens before a tenant is known: the
 * `state` is what identifies the organization, and matching on it in constant
 * time is what stops a forged callback attaching somebody else's QuickBooks
 * company to this one (docs/04 §5, exception 4).
 */
export async function completeConnect(args: {
  state: string
  code: string
  realmId: string
}): Promise<CallbackResult> {
  const config = oauthConfig()
  if (!config) throw conflict('QuickBooks is not configured on this server.')

  const candidates = await unsafeDb.integrationConnection.findMany({
    where: { provider: PROVIDER, status: 'CONNECTING' },
    select: { id: true, organizationId: true, oauthState: true, oauthStateIssuedAt: true, environment: true, realmId: true },
  })

  const connection = candidates.find(
    (row) => row.oauthState && safeEqual(row.oauthState, args.state),
  )
  if (!connection) throw notFound('That QuickBooks connection request')

  if (
    !connection.oauthStateIssuedAt ||
    Date.now() - connection.oauthStateIssuedAt.getTime() > STATE_TTL_MS
  ) {
    throw conflict('That QuickBooks connection link has expired. Start again from Settings.')
  }

  const tokens = await exchangeCode(config, args.code)
  const realmId = args.realmId || tokens.realmId
  if (!realmId) throw conflict('QuickBooks did not say which company was connected.')

  /**
   * A different company than last time means the old mappings point into books
   * that are not these books. They are kept — history is never deleted — but
   * they must not be reused, so they are marked for the previous realm (§10).
   */
  if (connection.realmId && connection.realmId !== realmId) {
    await unsafeDb.externalMapping.updateMany({
      where: { organizationId: connection.organizationId, provider: PROVIDER },
      data: {
        status: 'NEEDS_ATTENTION',
        lastError: `Mapped to QuickBooks company ${connection.realmId}, which is not the company now connected (${realmId}).`,
      },
    })
  }

  const client = createQuickBooksClient({
    realmId,
    environment: connection.environment,
    accessToken: tokens.accessToken,
  })

  let companyName = 'QuickBooks company'
  let automatedSalesTax = false
  try {
    companyName = (await client.getCompanyInfo()).CompanyName
    automatedSalesTax = (await client.getTaxService()).automatedSalesTaxEnabled
  } catch {
    // A company whose name we cannot read is still connected. The name is for
    // humans; the realm id is the identity.
  }

  const settings = readSettings(null)
  settings.tax.automatedSalesTaxEnabled = automatedSalesTax

  await unsafeDb.integrationConnection.update({
    where: { id: connection.id },
    data: {
      status: 'CONNECTED',
      realmId,
      companyName,
      ...sealTokens(tokens),
      connectedAt: new Date(),
      oauthState: null,
      oauthStateIssuedAt: null,
      lastError: null,
      settingsJson: settings as unknown as Prisma.InputJsonObject,
    },
  })

  return { organizationId: connection.organizationId, companyName, realmId }
}

function sealTokens(tokens: TokenSet) {
  return {
    accessTokenEncrypted: seal(tokens.accessToken),
    refreshTokenEncrypted: seal(tokens.refreshToken),
    tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
    refreshExpiresAt: new Date(Date.now() + tokens.refreshExpiresIn * 1000),
    grantedScope: tokens.scope,
    tokenRotatedAt: new Date(),
  }
}

/**
 * Disconnecting (§10).
 *
 * Credentials go. Mappings, sync logs and every SnackLoad document stay exactly
 * as they were: the QuickBooks copies are real, and a reconnection to the same
 * company should find its work already done rather than duplicate it.
 */
export async function disconnect(ctx: AuthContext): Promise<void> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const connection = await prisma.integrationConnection.findFirst({
    where: { provider: PROVIDER },
    select: { id: true, refreshTokenEncrypted: true, realmId: true, companyName: true },
  })
  if (!connection) return

  const config = oauthConfig()
  if (config && connection.refreshTokenEncrypted) {
    // Best effort: our copy goes either way. Leaving a usable secret in the
    // database because Intuit was unreachable is the worse failure.
    await revokeToken(config, open(connection.refreshTokenEncrypted))
  }

  await prisma.$transaction(async (tx) => {
    await tx.integrationConnection.update({
      where: { id: connection.id },
      data: {
        status: 'DISCONNECTED',
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        refreshExpiresAt: null,
        grantedScope: null,
        oauthState: null,
        oauthStateIssuedAt: null,
      },
    })

    await writeAudit(tx, ctx, {
      action: 'integration.disconnected',
      entityType: 'IntegrationConnection',
      entityId: connection.id,
      after: { provider: 'QuickBooks Online', company: connection.companyName, realmId: connection.realmId },
    })
  })
}

// ─── tokens ──────────────────────────────────────────────────────────────────

/**
 * A usable access token, refreshing if needed.
 *
 * **Rotation is the whole difficulty.** Intuit returns a new refresh token on
 * every refresh and invalidates the old one, so the write has to happen before
 * anything else can use the connection — and two workers refreshing at once
 * would have one of them invalidate the other's token.
 *
 * `SELECT … FOR UPDATE` on the connection row serialises that: the second
 * caller waits, then re-reads and finds a token that is already fresh. The same
 * discipline as the inventory ledger, for the same reason (docs/02 §L3).
 */
export async function accessTokenFor(organizationId: string): Promise<string> {
  const config = oauthConfig()
  if (!config) throw conflict('QuickBooks is not configured on this server.')

  return unsafeDb.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM integration_connection
       WHERE organization_id = ${organizationId} AND provider = 'QUICKBOOKS_ONLINE'
       FOR UPDATE
    `)
    if (!rows[0]) throw notFound('That QuickBooks connection')

    const connection = await tx.integrationConnection.findUniqueOrThrow({
      where: { id: rows[0].id },
      select: {
        id: true, status: true, accessTokenEncrypted: true, refreshTokenEncrypted: true,
        tokenExpiresAt: true,
      },
    })

    if (connection.status !== 'CONNECTED') {
      throw conflict('QuickBooks is not connected.')
    }

    const stillFresh =
      connection.accessTokenEncrypted &&
      connection.tokenExpiresAt &&
      connection.tokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS

    if (stillFresh) return open(connection.accessTokenEncrypted!)
    if (!connection.refreshTokenEncrypted) {
      throw conflict('QuickBooks needs to be reconnected.')
    }

    try {
      const tokens = await refreshTokens(config, open(connection.refreshTokenEncrypted))
      await tx.integrationConnection.update({
        where: { id: connection.id },
        data: { ...sealTokens(tokens), lastError: null },
      })
      return tokens.accessToken
    } catch (error) {
      if (error instanceof OAuthError && error.permanent) {
        // The grant is gone. Sales carry on; sync waits for a person. Mappings
        // are untouched, so reconnecting resumes rather than restarts (§3).
        await tx.integrationConnection.update({
          where: { id: connection.id },
          data: {
            status: 'NEEDS_REAUTH',
            accessTokenEncrypted: null,
            lastError: 'QuickBooks would not renew the connection. Reconnect to resume syncing.',
          },
        })
        throw conflict('QuickBooks needs to be reconnected.')
      }
      throw error
    }
  })
}

// ─── the client, for workers and actions ─────────────────────────────────────

/**
 * Swapped for the fake in tests. Module-level rather than threaded through
 * every call site because the alternative is an adapter argument on every
 * server action, which is noise everywhere to serve one test concern.
 */
let clientOverride: QuickBooksClient | null = null

export function setQuickBooksClientForTesting(client: QuickBooksClient | null): void {
  clientOverride = client
}

export function fakeQuickBooksForTesting(...args: Parameters<typeof createFakeQuickBooks>) {
  const fake = createFakeQuickBooks(...args)
  clientOverride = fake
  return fake
}

export async function clientFor(organizationId: string): Promise<QuickBooksClient> {
  if (clientOverride) return clientOverride

  // A development-only escape hatch, so the screens can be driven without an
  // Intuit app. `env()` refuses to start with this set in production.
  if (env().QUICKBOOKS_USE_FAKE) {
    clientOverride = createFakeQuickBooks()
    return clientOverride
  }

  const connection = await unsafeDb.integrationConnection.findFirst({
    where: { organizationId, provider: PROVIDER },
    select: { realmId: true, environment: true },
  })
  if (!connection?.realmId) throw conflict('QuickBooks is not connected.')

  return createQuickBooksClient({
    realmId: connection.realmId,
    environment: connection.environment,
    accessToken: await accessTokenFor(organizationId),
  })
}

// ─── configuration ───────────────────────────────────────────────────────────

export async function listQuickBooksAccounts(ctx: AuthContext): Promise<QboAccount[]> {
  requirePermission(ctx, 'org:manage_integrations')
  const client = await clientFor(ctx.organizationId)
  return client.listAccounts()
}

export async function saveSettings(
  ctx: AuthContext,
  settings: QuickBooksSettings,
): Promise<void> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const connection = await prisma.integrationConnection.findFirst({
    where: { provider: PROVIDER },
    select: { id: true, settingsJson: true },
  })
  if (!connection) throw notFound('That QuickBooks connection')

  await prisma.$transaction(async (tx) => {
    await tx.integrationConnection.update({
      where: { id: connection.id },
      data: { settingsJson: settings as unknown as Prisma.InputJsonObject },
    })

    // Account mapping changes are audited: they decide where somebody's revenue
    // lands, and "who changed the income account" is a question that gets asked.
    await writeAudit(tx, ctx, {
      action: 'integration.settings_changed',
      entityType: 'IntegrationConnection',
      entityId: connection.id,
      before: readSettings(connection.settingsJson) as unknown as Record<string, unknown>,
      after: settings as unknown as Record<string, unknown>,
    })
  })

  // A mapping that was blocked on a missing account can go now.
  await prisma.syncJob.updateMany({
    where: { status: 'NEEDS_ATTENTION', errorCategory: 'MAPPING' },
    data: { status: 'PENDING', nextAttemptAt: new Date(), lastError: null, errorCategory: null },
  })
}

// ─── running the sync ────────────────────────────────────────────────────────

/**
 * SYNC NOW. Enqueues and drains a bounded number of jobs.
 *
 * Bounded deliberately: a button that runs a thousand HTTP calls inside one
 * request is a timeout with a spinner on it. The queue is durable, so the rest
 * is picked up by the next pass (§4).
 */
export async function syncNow(ctx: AuthContext, limit = 50): Promise<DrainResult> {
  requirePermission(ctx, 'org:manage_integrations')
  const client = await clientFor(ctx.organizationId)
  return drain({ organizationId: ctx.organizationId, userId: ctx.userId, client, limit })
}

/**
 * Queues everything a newly connected company has not sent yet.
 *
 * Bounded by date rather than "everything ever": a distributor connecting after
 * two years of trading does not want two years of invoices appearing in books
 * that already closed those periods.
 */
export async function backfill(
  ctx: AuthContext,
  since: Date,
): Promise<{ sales: number; payments: number; credits: number }> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const [sales, payments, credits] = await Promise.all([
    prisma.sale.findMany({
      where: { status: 'COMPLETED', occurredAt: { gte: since } },
      select: { id: true },
    }),
    prisma.payment.findMany({
      where: { status: 'POSTED', receivedAt: { gte: since } },
      select: { id: true },
    }),
    prisma.creditMemo.findMany({
      where: { status: { not: 'VOIDED' }, issuedAt: { gte: since } },
      select: { id: true },
    }),
  ])

  for (const sale of sales) {
    await enqueue(prisma, ctx.organizationId, { entityType: 'Sale', localId: sale.id, operation: 'CREATE' })
  }
  for (const payment of payments) {
    await enqueue(prisma, ctx.organizationId, { entityType: 'Payment', localId: payment.id, operation: 'CREATE' })
  }
  for (const credit of credits) {
    await enqueue(prisma, ctx.organizationId, { entityType: 'CreditMemo', localId: credit.id, operation: 'CREATE' })
  }

  return { sales: sales.length, payments: payments.length, credits: credits.length }
}

// ─── issues and history ──────────────────────────────────────────────────────

export type SyncIssue = {
  jobId: string
  entityType: string
  localId: string
  documentNumber: string | null
  customerName: string | null
  status: string
  category: string | null
  message: string | null
  attempts: number
  lastAttemptedAt: Date | null
  retryable: boolean
  /** What a person can actually do about it. */
  action: 'RETRY' | 'REMAP_CUSTOMER' | 'REMAP_ITEM' | 'CHANGE_ACCOUNTS' | 'RECONNECT' | 'REVIEW_DOCUMENT'
  suggestion: string
  /** Where the document lives in SnackLoad, so the issue is one click from it. */
  href: string | null
}

const ACTION_FOR: Record<string, { action: SyncIssue['action']; suggestion: string }> = {
  MAPPING: {
    action: 'CHANGE_ACCOUNTS',
    suggestion: 'Check the account mappings below — something they point at is missing in QuickBooks.',
  },
  AUTHORIZATION: {
    action: 'RECONNECT',
    suggestion: 'Reconnect QuickBooks. The authorization was revoked or expired.',
  },
  TAX_MISMATCH: {
    action: 'CHANGE_ACCOUNTS',
    suggestion:
      'QuickBooks recorded a different tax figure. Check the tax code mapping, or whether this company has Automated Sales Tax turned on.',
  },
  AMOUNT_MISMATCH: {
    action: 'REVIEW_DOCUMENT',
    suggestion: 'QuickBooks recorded a different total. Compare the two documents before retrying.',
  },
  EXTERNAL_CONFLICT: {
    action: 'REVIEW_DOCUMENT',
    suggestion:
      'Somebody edited this document in QuickBooks. SnackLoad will not overwrite it — reconcile the two, then retry.',
  },
  VALIDATION: {
    action: 'REVIEW_DOCUMENT',
    suggestion: 'QuickBooks rejected the document. Its own message is above.',
  },
  DEPENDENCY: {
    action: 'RETRY',
    suggestion: 'Waiting on another document. It will go automatically once that one syncs.',
  },
  TRANSIENT: { action: 'RETRY', suggestion: 'A temporary problem. Retry when you like.' },
}

export async function listSyncIssues(ctx: AuthContext, limit = 100): Promise<SyncIssue[]> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const jobs = await prisma.syncJob.findMany({
    where: { status: { in: ['NEEDS_ATTENTION', 'FAILED', 'BLOCKED_DEPENDENCY'] } },
    orderBy: { lastAttemptedAt: 'desc' },
    take: limit,
    select: {
      id: true, entityType: true, localId: true, status: true, errorCategory: true,
      lastError: true, attempts: true, lastAttemptedAt: true,
    },
  })

  return Promise.all(jobs.map((job) => describeIssue(ctx, job)))
}

async function describeIssue(
  ctx: AuthContext,
  job: {
    id: string; entityType: string; localId: string; status: string
    errorCategory: string | null; lastError: string | null; attempts: number
    lastAttemptedAt: Date | null
  },
): Promise<SyncIssue> {
  const label = await describeDocument(ctx, job.entityType, job.localId)
  const guidance = ACTION_FOR[job.errorCategory ?? 'TRANSIENT'] ?? ACTION_FOR.TRANSIENT

  // A mapping problem on a customer or an item is remappable specifically,
  // which is a more useful button than "change the account mappings".
  const action =
    job.errorCategory === 'MAPPING' && job.entityType === 'Customer'
      ? 'REMAP_CUSTOMER'
      : job.errorCategory === 'MAPPING' && job.entityType === 'Product'
        ? 'REMAP_ITEM'
        : guidance.action

  return {
    jobId: job.id,
    entityType: job.entityType,
    localId: job.localId,
    documentNumber: label.number,
    customerName: label.customerName,
    status: job.status,
    category: job.errorCategory,
    message: job.lastError,
    attempts: job.attempts,
    lastAttemptedAt: job.lastAttemptedAt,
    retryable: job.errorCategory === 'TRANSIENT' || job.status === 'BLOCKED_DEPENDENCY',
    action,
    suggestion: guidance.suggestion,
    href: label.href,
  }
}

/** The document's own number and store, so an issue reads like a document. */
async function describeDocument(
  ctx: AuthContext,
  entityType: string,
  localId: string,
): Promise<{ number: string | null; customerName: string | null; href: string | null }> {
  const prisma = db(ctx)

  switch (entityType) {
    case 'Sale': {
      const row = await prisma.sale.findFirst({
        where: { id: localId },
        select: { saleNumber: true, customer: { select: { name: true } } },
      })
      return { number: row?.saleNumber ?? null, customerName: row?.customer.name ?? null, href: `/receipts/${localId}` }
    }
    case 'Payment': {
      const row = await prisma.payment.findFirst({
        where: { id: localId },
        select: { customer: { select: { id: true, name: true } } },
      })
      return {
        number: null,
        customerName: row?.customer.name ?? null,
        href: row ? `/customers/${row.customer.id}` : null,
      }
    }
    case 'CreditMemo': {
      const row = await prisma.creditMemo.findFirst({
        where: { id: localId },
        select: { number: true, customer: { select: { name: true } } },
      })
      return { number: row?.number ?? null, customerName: row?.customer.name ?? null, href: `/credits/${localId}` }
    }
    case 'CreditMemoApplication': {
      const row = await prisma.creditMemoApplication.findFirst({
        where: { id: localId },
        select: { creditMemo: { select: { id: true, number: true, customer: { select: { name: true } } } } },
      })
      return {
        number: row?.creditMemo.number ?? null,
        customerName: row?.creditMemo.customer.name ?? null,
        href: row ? `/credits/${row.creditMemo.id}` : null,
      }
    }
    case 'Refund': {
      const row = await prisma.refund.findFirst({
        where: { id: localId },
        select: { refundNumber: true, creditMemoId: true, customer: { select: { name: true } } },
      })
      return {
        number: row?.refundNumber ?? null,
        customerName: row?.customer.name ?? null,
        href: row ? `/credits/${row.creditMemoId}` : null,
      }
    }
    case 'Customer': {
      const row = await prisma.customer.findFirst({
        where: { id: localId },
        select: { name: true, accountNumber: true },
      })
      return { number: row?.accountNumber ?? null, customerName: row?.name ?? null, href: `/customers/${localId}` }
    }
    case 'Product': {
      const row = await prisma.product.findFirst({ where: { id: localId }, select: { name: true, sku: true } })
      return { number: row?.sku ?? null, customerName: row?.name ?? null, href: `/products/${localId}` }
    }
    case 'CogsJournalBatch': {
      const row = await prisma.cogsJournalBatch.findFirst({
        where: { id: localId },
        select: { periodStart: true, periodEnd: true },
      })
      return {
        number: row
          ? `COGS ${row.periodStart.toISOString().slice(0, 10)} – ${row.periodEnd.toISOString().slice(0, 10)}`
          : null,
        customerName: null,
        href: '/settings/integrations/quickbooks',
      }
    }
    default:
      return { number: null, customerName: null, href: null }
  }
}

export type SyncHistoryEntry = {
  jobId: string
  entityType: string
  documentNumber: string | null
  customerName: string | null
  status: string
  operation: string
  at: Date
  externalId: string | null
}

export async function listSyncHistory(ctx: AuthContext, limit = 40): Promise<SyncHistoryEntry[]> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const jobs = await prisma.syncJob.findMany({
    orderBy: [{ completedAt: 'desc' }, { lastAttemptedAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    select: {
      id: true, entityType: true, localId: true, status: true, operation: true,
      completedAt: true, lastAttemptedAt: true, createdAt: true,
    },
  })

  return Promise.all(
    jobs.map(async (job) => {
      const [label, mapping] = await Promise.all([
        describeDocument(ctx, job.entityType, job.localId),
        prisma.externalMapping.findFirst({
          where: { provider: PROVIDER, entityType: job.entityType, localId: job.localId },
          select: { externalId: true },
        }),
      ])

      return {
        jobId: job.id,
        entityType: job.entityType,
        documentNumber: label.number,
        customerName: label.customerName,
        status: job.status,
        operation: job.operation,
        at: job.completedAt ?? job.lastAttemptedAt ?? job.createdAt,
        externalId: mapping?.externalId ?? null,
      }
    }),
  )
}

/** Puts one job back in the queue. The request id is deliberately unchanged. */
export async function retryJob(ctx: AuthContext, jobId: string): Promise<void> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const job = await prisma.syncJob.findFirst({ where: { id: jobId }, select: { id: true } })
  if (!job) throw notFound('That sync job')

  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status: 'PENDING',
      nextAttemptAt: new Date(),
      blockedOnJobId: null,
      lastError: null,
      errorCategory: null,
      errorCode: null,
      // attempts is NOT reset: the history of how hard this has been tried is
      // what tells somebody it is not going to start working on its own.
    },
  })
}

/**
 * Re-sends a document that is already mapped (§10).
 *
 * Uses the mapping and QuickBooks' SyncToken to update in place. It cannot
 * create a duplicate, and it cannot change SnackLoad's figures — everything it
 * sends comes off the posted document.
 */
export async function resyncDocument(
  ctx: AuthContext,
  entityType: string,
  localId: string,
): Promise<void> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const mapping = await prisma.externalMapping.findFirst({
    where: { provider: PROVIDER, entityType, localId },
    select: { id: true },
  })
  if (!mapping) throw notFound('That QuickBooks mapping')

  // Clearing the hash is what makes the syncer send rather than skip; the
  // external id stays, so it is an update to the same document.
  await prisma.externalMapping.update({ where: { id: mapping.id }, data: { sourceHash: null } })
  await enqueue(prisma, ctx.organizationId, {
    entityType: entityType as Parameters<typeof enqueue>[2]['entityType'],
    localId,
    operation: 'UPDATE',
    // A person asked for this one specifically. Without a fresh id, Intuit
    // would replay the response that created the document and change nothing.
    rotateRequestId: true,
  })
}

/** Manual mapping, for a customer or item that already exists in QuickBooks (§5). */
export async function mapManually(
  ctx: AuthContext,
  entityType: 'Customer' | 'Product',
  localId: string,
  externalId: string,
): Promise<void> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  await prisma.externalMapping.upsert({
    where: {
      organizationId_provider_entityType_localId: {
        organizationId: ctx.organizationId,
        provider: PROVIDER,
        entityType,
        localId,
      },
    },
    create: {
      organizationId: ctx.organizationId,
      provider: PROVIDER,
      entityType,
      localId,
      externalId,
      status: 'SYNCED',
      lastSucceededAt: new Date(),
    },
    // The hash is cleared so the next sync pushes our fields onto their record
    // rather than assuming the two already agree.
    update: { externalId, status: 'SYNCED', sourceHash: null, lastError: null },
  })

  await prisma.syncJob.updateMany({
    where: { entityType, localId, status: { in: ['NEEDS_ATTENTION', 'FAILED'] } },
    data: { status: 'PENDING', nextAttemptAt: new Date(), lastError: null, errorCategory: null },
  })
}

// ─── split-payment reconciliation ────────────────────────────────────────────

export type PaymentReconciliation = {
  paymentId: string
  customerName: string
  receivedAt: Date
  method: string
  /** What the runner actually collected. */
  collected: string
  /** What QuickBooks holds for it, which can legitimately be less. */
  inQuickBooks: string
  components: {
    representation: 'INVOICE_PAYMENT' | 'SALES_RECEIPT' | 'UNAPPLIED'
    saleNumber: string | null
    amount: string
    externalId: string | null
    explanation: string
  }[]
  /** Collected minus the sum of the components. Zero, or there is a bug. */
  unaccounted: string
  balanced: boolean
}

/**
 * Why a QuickBooks payment total differs from the SnackLoad one (docs/08 §18).
 *
 * The answer is rows, not arithmetic a support person has to redo: every slice
 * of the collection says where it lives, and the three add up to what was
 * taken. Without this the screen shows $300 here and $200 there and no reason,
 * which is indistinguishable from a bug.
 */
export async function describePaymentSync(
  ctx: AuthContext,
  paymentId: string,
): Promise<PaymentReconciliation | null> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId },
    select: {
      id: true, amount: true, method: true, receivedAt: true,
      customer: { select: { name: true } },
      syncAllocations: {
        orderBy: { createdAt: 'asc' },
        select: {
          representation: true, amount: true, externalId: true, explanation: true,
          sale: { select: { saleNumber: true } },
        },
      },
    },
  })
  if (!payment) return null

  const components = payment.syncAllocations.map((row) => ({
    representation: row.representation,
    saleNumber: row.sale?.saleNumber ?? null,
    amount: toAmountString(row.amount),
    externalId: row.externalId,
    explanation: row.explanation,
  }))

  const accounted = components.reduce((total, row) => total.plus(m(row.amount)), m(0))
  const inQuickBooks = components
    .filter((row) => row.representation !== 'SALES_RECEIPT')
    .reduce((total, row) => total.plus(m(row.amount)), m(0))

  return {
    paymentId: payment.id,
    customerName: payment.customer.name,
    receivedAt: payment.receivedAt,
    method: payment.method,
    collected: toAmountString(payment.amount),
    inQuickBooks: toAmountString(inQuickBooks),
    components,
    unaccounted: toAmountString(m(payment.amount).minus(accounted)),
    balanced: m(payment.amount).equals(accounted),
  }
}

/**
 * The payments whose two totals differ, which are the only ones worth a screen.
 * A collection entirely against invoices needs no explanation.
 */
export async function listSplitPayments(
  ctx: AuthContext,
  limit = 20,
): Promise<PaymentReconciliation[]> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const rows = await prisma.paymentSyncAllocation.findMany({
    where: { representation: 'SALES_RECEIPT' },
    orderBy: { createdAt: 'desc' },
    take: limit * 4,
    select: { paymentId: true },
  })

  const ids = [...new Set(rows.map((row) => row.paymentId))].slice(0, limit)
  const described = await Promise.all(ids.map((id) => describePaymentSync(ctx, id)))
  return described.filter((entry): entry is PaymentReconciliation => entry !== null)
}
