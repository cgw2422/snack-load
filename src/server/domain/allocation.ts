import type { Decimal } from 'decimal.js'
import { m, minMoney, round2, sum } from './money'

/**
 * Applying a payment to open invoices (docs/02 §A3).
 *
 * Pure: given what is owed and what was handed over, decide where it lands.
 * Over-payment is legal and becomes credit on account; partial payment is legal
 * and leaves a balance. The invariant the caller relies on is that allocations
 * plus the unapplied remainder always equal the payment exactly.
 */

export type OpenInvoice = {
  saleId: string
  balanceDue: string | number | Decimal
  /** Used for oldest-first ordering; falls back to occurredAt. */
  dueDate: Date
  occurredAt: Date
}

export type Allocation = { saleId: string; amount: Decimal }

export type AllocationResult = {
  allocations: Allocation[]
  unapplied: Decimal
}

/** Oldest debt first, which is what a distributor means by "put it on the account". */
export function allocateOldestFirst(
  amount: string | number | Decimal,
  invoices: OpenInvoice[],
): AllocationResult {
  let remaining = round2(amount)
  const allocations: Allocation[] = []

  const ordered = [...invoices].sort(
    (a, b) =>
      a.dueDate.getTime() - b.dueDate.getTime() ||
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      a.saleId.localeCompare(b.saleId),
  )

  for (const invoice of ordered) {
    if (remaining.lessThanOrEqualTo(0)) break
    const owed = round2(invoice.balanceDue)
    if (owed.lessThanOrEqualTo(0)) continue

    const applied = round2(minMoney(remaining, owed))
    allocations.push({ saleId: invoice.saleId, amount: applied })
    remaining = remaining.minus(applied)
  }

  return { allocations, unapplied: remaining }
}

export class AllocationError extends Error {}

/** Caller-supplied allocations, checked against what is actually owed. */
export function allocateSpecific(
  amount: string | number | Decimal,
  requested: { saleId: string; amount: string | number | Decimal }[],
  invoices: OpenInvoice[],
): AllocationResult {
  const owedBySale = new Map(invoices.map((i) => [i.saleId, round2(i.balanceDue)]))
  const allocations: Allocation[] = []

  for (const line of requested) {
    const applied = round2(line.amount)
    if (applied.lessThanOrEqualTo(0)) continue

    const owed = owedBySale.get(line.saleId)
    if (owed === undefined) {
      throw new AllocationError(`That payment refers to an invoice with nothing outstanding.`)
    }
    if (applied.greaterThan(owed)) {
      throw new AllocationError(
        `Cannot apply ${applied.toFixed(2)} to an invoice that only owes ${owed.toFixed(2)}.`,
      )
    }
    allocations.push({ saleId: line.saleId, amount: applied })
  }

  const total = round2(amount)
  const allocated = sum(allocations.map((a) => a.amount))
  if (allocated.greaterThan(total)) {
    throw new AllocationError('Those allocations add up to more than the payment.')
  }

  return { allocations, unapplied: total.minus(allocated) }
}

/** The invariant every caller depends on, asserted before anything is written. */
export function assertAllocationIdentity(
  amount: string | number | Decimal,
  result: AllocationResult,
): void {
  const total = round2(amount)
  const accounted = sum(result.allocations.map((a) => a.amount)).plus(result.unapplied)
  if (!accounted.equals(total)) {
    throw new AllocationError(
      `Allocations (${accounted.toFixed(2)}) do not account for the payment (${total.toFixed(2)}).`,
    )
  }
  if (result.unapplied.isNegative()) {
    throw new AllocationError('A payment cannot allocate more than its own amount.')
  }
}

/** Aging buckets, measured from the due date (docs/02 §A5). */
export type AgingBucket = 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90_PLUS'

export function agingBucket(dueDate: Date, asOf: Date): AgingBucket {
  const days = Math.floor((asOf.getTime() - dueDate.getTime()) / 86_400_000)
  if (days <= 0) return 'CURRENT'
  if (days <= 30) return 'D1_30'
  if (days <= 60) return 'D31_60'
  if (days <= 90) return 'D61_90'
  return 'D90_PLUS'
}

export const AGING_LABELS: Record<AgingBucket, string> = {
  CURRENT: 'Current',
  D1_30: '1–30 days',
  D31_60: '31–60 days',
  D61_90: '61–90 days',
  D90_PLUS: '90+ days',
}

export function summarizeAging(
  invoices: { balanceDue: string | number | Decimal; dueDate: Date }[],
  asOf: Date,
): Record<AgingBucket, Decimal> {
  const totals: Record<AgingBucket, Decimal> = {
    CURRENT: m(0), D1_30: m(0), D31_60: m(0), D61_90: m(0), D90_PLUS: m(0),
  }
  for (const invoice of invoices) {
    const bucket = agingBucket(invoice.dueDate, asOf)
    totals[bucket] = totals[bucket].plus(round2(invoice.balanceDue))
  }
  return totals
}
