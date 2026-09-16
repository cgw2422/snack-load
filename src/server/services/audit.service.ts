import type { Prisma } from '@/generated/prisma/client'
import type { AuthContext } from '@/server/auth/context'

/**
 * Structural, so both the tenant-scoped client and the raw one satisfy it. The
 * alternative — naming Prisma's extended transaction type — drags a different
 * generic signature into every service that writes an audit row.
 */
export type AuditCapable = {
  auditLog: { create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown> }
}

/**
 * Audit entries are written inside the same transaction as the change they
 * describe (docs/04 §8), so an audit row cannot go missing when a write succeeds.
 * That is why this takes a transaction client rather than reaching for its own.
 */

/** Never recorded in an audit payload, whatever model it came from. */
const REDACTED = new Set([
  'passwordHash', 'tokenHash', 'accessTokenEncrypted', 'refreshTokenEncrypted', 'imagePng',
])

export function redact<T extends Record<string, unknown>>(value: T | null | undefined) {
  if (!value) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED.has(k) ? '[redacted]' : v instanceof Date ? v.toISOString() : v
  }
  return out as Prisma.InputJsonValue
}

export async function writeAudit(
  tx: AuditCapable,
  ctx: AuthContext,
  entry: {
    action: string
    entityType: string
    entityId: string
    before?: Record<string, unknown> | null
    after?: Record<string, unknown> | null
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeJson: redact(entry.before),
      afterJson: redact(entry.after),
    },
  })
}

/** Only the fields that actually changed, so an audit row reads as a diff. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(after)) {
    const previous = before[key]
    const same =
      previous instanceof Date && value instanceof Date
        ? previous.getTime() === value.getTime()
        : String(previous ?? '') === String(value ?? '')
    if (!same) {
      b[key] = previous
      a[key] = value
    }
  }
  return { before: b, after: a }
}
