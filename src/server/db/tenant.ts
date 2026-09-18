import { unsafeDb } from './client'
import { AppError } from '@/lib/errors'

/**
 * Tenant isolation, layer 2 (docs/04 §5).
 *
 * App code never imports `unsafeDb`. It calls `db(ctx)`, which returns a Prisma
 * client whose every operation on a tenant-owned model is rewritten to carry
 * `organizationId`. A missing `where` clause is therefore not a data leak, it is
 * simply impossible to express.
 *
 * Known boundaries of this mechanism, stated plainly:
 *   - `$queryRaw` bypasses extensions. Raw SQL must filter by organization by
 *     hand, and is reviewed as security-sensitive.
 *   - Nested writes are not traversed. They do not need to be: `organizationId`
 *     is a required column on every tenant model, so a nested create that omits
 *     it fails to typecheck and fails at runtime.
 */

/** Every model carrying an `organizationId` column. Asserted against the schema in tests. */
export const TENANT_MODELS = [
  'Membership', 'Role', 'Invitation', 'Session',
  'Supplier', 'ProductCategory', 'Product', 'ProductUom', 'TaxRate',
  'PriceGroup', 'PriceGroupPrice', 'CustomerPrice',
  'Customer', 'CustomerContact',
  'InventoryLocation', 'Warehouse', 'Vehicle', 'InventoryBalance',
  'InventoryTransaction', 'InventoryTransactionLine',
  'Receiving', 'ReceivingItem', 'TruckLoad', 'TruckLoadItem',
  'RouteTemplate', 'CustomerSchedule', 'Route', 'RouteStop',
  'RouteAssignmentHistory', 'RouteCloseout', 'RouteCloseoutItem',
  'Sale', 'SaleItem', 'Receipt', 'ReceiptDelivery', 'ReceiptShareLink', 'Signature',
  'Payment', 'PaymentAllocation', 'PaymentSyncAllocation',
  'Return', 'ReturnItem',
  'CreditMemo', 'CreditMemoItem', 'CreditMemoApplication', 'Refund',
  'DocumentSequence',
  'ImportJob', 'ImportRow',
  'IntegrationConnection', 'ExternalMapping', 'SyncJob', 'SyncLog', 'CogsJournalBatch',
  'OutboxEvent', 'Notification', 'AuditLog',
] as const

const TENANT_MODEL_SET: ReadonlySet<string> = new Set(TENANT_MODELS)

/**
 * Financial and ledger history is never destroyed (docs/01 §9). Voiding,
 * reversing, and deactivating are the supported paths; `delete` is not one.
 */
export const UNDELETABLE_MODELS: ReadonlySet<string> = new Set([
  'Sale', 'SaleItem', 'Receipt', 'ReceiptDelivery', 'Payment', 'PaymentAllocation',
  'Return', 'ReturnItem',
  'CreditMemo', 'CreditMemoItem', 'CreditMemoApplication', 'Refund',
  'InventoryTransaction', 'InventoryTransactionLine', 'AuditLog',
  // A posted COGS journal is a period's cost as it was reported. It is voided,
  // never removed, for the same reason a posted sale is (docs/08 §9).
  'CogsJournalBatch',
])

const WHERE_OPS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'delete', 'deleteMany',
])
const DATA_OPS = new Set(['create', 'createMany', 'createManyAndReturn'])
const DELETE_OPS = new Set(['delete', 'deleteMany'])

type AnyArgs = Record<string, unknown>

function scopeWhere(args: AnyArgs, organizationId: string): void {
  const where = (args.where ?? {}) as AnyArgs

  // Silently rewriting a caller-supplied organizationId would be safe but
  // dishonest: the query would quietly return rows the caller did not ask for.
  // Reaching here means a service built a cross-tenant query, so say so.
  if (where.organizationId !== undefined && where.organizationId !== organizationId) {
    throw new AppError(
      'FORBIDDEN',
      'Cross-organization access is not permitted. Scope comes from the session, not the query.',
    )
  }

  where.organizationId = organizationId
  args.where = where
}

function assertOwnOrg(row: AnyArgs, organizationId: string): void {
  if (row.organizationId !== undefined && row.organizationId !== organizationId) {
    throw new AppError('FORBIDDEN', 'Cannot write a record into another organization.')
  }
}

function scopeData(args: AnyArgs, organizationId: string): void {
  const data = args.data
  if (Array.isArray(data)) {
    for (const row of data) {
      if (row && typeof row === 'object') {
        assertOwnOrg(row as AnyArgs, organizationId)
        ;(row as AnyArgs).organizationId ??= organizationId
      }
    }
  } else if (data && typeof data === 'object') {
    const row = data as AnyArgs
    assertOwnOrg(row, organizationId)
    // `organization: { connect: … }` is the relation form; don't fight with it.
    if (!('organization' in row)) row.organizationId ??= organizationId
  }
}

function buildScopedClient(organizationId: string) {
  return unsafeDb.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          if (!model || !TENANT_MODEL_SET.has(model)) return query(args)

          if (DELETE_OPS.has(operation) && UNDELETABLE_MODELS.has(model)) {
            throw new AppError(
              'CONFLICT',
              `${model} records are never deleted. Void or reverse the document instead.`,
            )
          }

          const next: AnyArgs = { ...(args ?? {}) }

          if (WHERE_OPS.has(operation)) scopeWhere(next, organizationId)

          if (DATA_OPS.has(operation)) scopeData(next, organizationId)

          if (operation === 'upsert') {
            scopeWhere(next, organizationId)
            const create = next.create as AnyArgs | undefined
            if (create && !('organization' in create)) create.organizationId ??= organizationId
          }

          return query(next)
        },
      },
    },
  })
}

export type TenantDb = ReturnType<typeof buildScopedClient>

/**
 * What a `db(ctx).$transaction(async (tx) => …)` callback receives. Services that
 * post inside a caller's transaction take this, so every write in the app — the
 * ledger engine included — runs through the scoped client rather than the raw one.
 */
export type TenantTx = Omit<
  TenantDb,
  '$connect' | '$disconnect' | '$on' | '$use' | '$extends' | '$transaction'
>

/** Scoped clients are memoized per organization; building one per request is waste. */
const cache = new Map<string, TenantDb>()

export function db(scope: { organizationId: string }): TenantDb {
  const existing = cache.get(scope.organizationId)
  if (existing) return existing
  const created = buildScopedClient(scope.organizationId)
  // Bounded so a large tenant count cannot grow this without limit.
  if (cache.size > 256) cache.clear()
  cache.set(scope.organizationId, created)
  return created
}
