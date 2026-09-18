import type { TenantDb } from '@/server/db/tenant'
import { conflict } from '@/lib/errors'
import { readSettings, type QuickBooksSettings } from '../settings'
import type { QuickBooksClient, Ref } from '../types'
import { beginAttempt, externalIdFor, type EntityType } from '../mapping'

/**
 * What a syncer is handed (docs/08 §7).
 *
 * One object carrying the tenant-scoped database, the adapter, the account
 * mappings and the helpers for resolving references. Passed rather than
 * imported so a test can drive the whole engine against the fake without any
 * module-level state to reset between cases.
 */
export type SyncContext = {
  organizationId: string
  userId: string | null
  prisma: TenantDb
  client: QuickBooksClient
  settings: QuickBooksSettings
  /** Reused across a whole worker pass, so one drain maps a customer once. */
  refCache: Map<string, Ref>
}

/** Raised when a document cannot sync until another one has. */
export class DependencyNotReady extends Error {
  constructor(
    readonly entityType: EntityType,
    readonly localId: string,
    message: string,
  ) {
    super(message)
    this.name = 'DependencyNotReady'
  }
}

export function loadSettings(settingsJson: unknown): QuickBooksSettings {
  return readSettings(settingsJson)
}

/**
 * Resolves a reference that must already exist.
 *
 * Throws `DependencyNotReady` rather than creating the missing document inline:
 * an invoice's job must not quietly become a customer's job, because then a
 * failure to create the customer looks like a failure to create the invoice and
 * the issues screen tells a human the wrong thing (§4).
 */
export async function requireRef(
  ctx: SyncContext,
  entityType: EntityType,
  localId: string,
  describe: () => string,
): Promise<Ref> {
  const cacheKey = `${entityType}:${localId}`
  const cached = ctx.refCache.get(cacheKey)
  if (cached) return cached

  const externalId = await externalIdFor(ctx.prisma, entityType, localId)
  if (!externalId) {
    throw new DependencyNotReady(entityType, localId, describe())
  }

  const ref: Ref = { value: externalId }
  ctx.refCache.set(cacheKey, ref)
  return ref
}

export { beginAttempt, conflict }
