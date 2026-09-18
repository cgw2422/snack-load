import { randomUUID } from 'node:crypto'
import { unsafeDb } from '@/server/db/client'
import { clientFor } from '@/server/services/integration.service'
import { drain, type DrainResult } from './worker'

/**
 * The scheduled worker (docs/08 §19).
 *
 * QuickBooks is not operationally finished if syncing only happens when
 * somebody presses a button. This runs the **same engine** the button runs —
 * there is deliberately no second queue, no second retry policy and no second
 * place for the two to disagree. `Sync now` and the cron differ only in who
 * called `drain`.
 *
 * It sweeps every connected organization, one at a time, with a per-tenant
 * budget. Serial rather than parallel because Intuit's limit is per company and
 * the failure mode of parallelism here is a 429 storm, not speed.
 */

export type SweepResult = {
  /** A new token per invocation, so an abandoned lease names its worker. */
  workerId: string
  startedAt: Date
  finishedAt: Date
  organizations: {
    organizationId: string
    companyName: string | null
    processed: number
    synced: number
    failed: number
    blocked: number
    stoppedBecause: DrainResult['stoppedBecause']
    error?: string
  }[]
  totals: { processed: number; synced: number; failed: number; blocked: number }
}

export type SweepOptions = {
  /** Jobs per organization per sweep. Bounded so one busy tenant cannot starve the rest. */
  perOrganization?: number
  /** Restrict to one tenant, for a targeted re-run. */
  organizationId?: string
  now?: () => Date
}

export async function sweep(options: SweepOptions = {}): Promise<SweepResult> {
  const now = options.now ?? (() => new Date())
  const workerId = `worker-${randomUUID()}`
  const startedAt = now()

  /**
   * Runs on the unscoped client because it spans tenants by definition — the
   * fourth documented exception alongside auth, the seeder and share links
   * (docs/04 §5). Every call it makes is then per-organization and scoped.
   */
  const connections = await unsafeDb.integrationConnection.findMany({
    where: {
      provider: 'QUICKBOOKS_ONLINE',
      status: 'CONNECTED',
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
    },
    select: { organizationId: true, companyName: true },
  })

  const result: SweepResult = {
    workerId,
    startedAt,
    finishedAt: startedAt,
    organizations: [],
    totals: { processed: 0, synced: 0, failed: 0, blocked: 0 },
  }

  for (const connection of connections) {
    try {
      const client = await clientFor(connection.organizationId)
      const drained = await drain({
        organizationId: connection.organizationId,
        client,
        limit: options.perOrganization ?? 100,
        leaseOwner: workerId,
        now,
      })

      result.organizations.push({
        organizationId: connection.organizationId,
        companyName: connection.companyName,
        ...drained,
      })
      result.totals.processed += drained.processed
      result.totals.synced += drained.synced
      result.totals.failed += drained.failed
      result.totals.blocked += drained.blocked
    } catch (error) {
      /**
       * One tenant's broken connection must not stop the sweep. A refresh
       * token that rotated out is exactly the kind of thing that would
       * otherwise silently stop every other distributor's books updating.
       */
      result.organizations.push({
        organizationId: connection.organizationId,
        companyName: connection.companyName,
        processed: 0,
        synced: 0,
        failed: 0,
        blocked: 0,
        stoppedBecause: 'NO_CONNECTION',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  result.finishedAt = now()
  await recordSweep(result)
  return result
}

/**
 * When the worker last ran, so the dashboard can say whether it is alive
 * without guessing (§19).
 *
 * Stored on each connection rather than in a global: an operator wants to know
 * whether **their** books are being kept up to date, and a worker that is
 * running but failing on their tenant is not healthy from where they sit.
 */
async function recordSweep(result: SweepResult): Promise<void> {
  for (const entry of result.organizations) {
    await unsafeDb.integrationConnection.updateMany({
      where: { organizationId: entry.organizationId, provider: 'QUICKBOOKS_ONLINE' },
      data: {
        lastWorkerRunAt: result.finishedAt,
        lastWorkerId: result.workerId,
      },
    })
  }
}
