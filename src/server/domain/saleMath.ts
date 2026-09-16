import type { Decimal } from 'decimal.js'
import { distributeProportionally, m, round2, sum, ZERO } from './money'
import { toBaseUnits } from './uom'

/**
 * Sale arithmetic (docs/02 §M2–M5).
 *
 * Pure: no I/O, no Prisma, no Node built-ins — so it is exhaustively testable and
 * can be bundled into React Native later for optimistic cart totals.
 *
 * The rule that shapes all of it: document totals are the sum of ALREADY-ROUNDED
 * line values. Rounding a sum of unrounded values makes `Σ lines ≠ total` on the
 * printed receipt, and the person holding it notices.
 */

export type LineInput = {
  quantity: number
  baseUnitsPerUom: number
  /** Price for ONE of the chosen UoM. A case price need not equal unit price × factor. */
  unitPrice: string | number | Decimal
  /** Line-level discount in currency, already decided by the caller. */
  discountAmount?: string | number | Decimal
  taxable: boolean
}

export type ComputedLine = {
  quantity: number
  baseQuantity: number
  unitPrice: Decimal
  lineSubtotal: Decimal
  discountAmount: Decimal
  taxableBase: Decimal
  taxAmount: Decimal
  lineTotal: Decimal
}

export type SaleTotalsInput = {
  lines: LineInput[]
  /** Fractional rate, e.g. 0.0725. Ignored when the customer is exempt. */
  taxRate: string | number | Decimal
  taxExempt: boolean
  /** Optional whole-document discount, spread across taxable lines. */
  documentDiscount?: string | number | Decimal
}

export type SaleTotals = {
  lines: ComputedLine[]
  subtotal: Decimal
  discountTotal: Decimal
  taxTotal: Decimal
  total: Decimal
}

/**
 * Boundary 1: line extension. Boundary 2: line tax. Those are the only two
 * places a value is rounded.
 */
export function computeSaleTotals(input: SaleTotalsInput): SaleTotals {
  const rate = input.taxExempt ? ZERO : m(input.taxRate)

  const extended = input.lines.map((line) => {
    const baseQuantity = toBaseUnits(line.quantity, line.baseUnitsPerUom)
    const unitPrice = m(line.unitPrice)
    const lineSubtotal = round2(unitPrice.times(line.quantity))
    const lineDiscount = round2(line.discountAmount ?? 0)
    return { line, baseQuantity, unitPrice, lineSubtotal, lineDiscount }
  })

  // A document-level discount is spread across lines in proportion to their
  // post-line-discount value, with the remainder landing on the largest line so
  // the parts sum exactly to the whole.
  const docDiscount = round2(input.documentDiscount ?? 0)
  const weights = extended.map((e) => e.lineSubtotal.minus(e.lineDiscount))
  const spread = docDiscount.isZero()
    ? weights.map(() => ZERO)
    : distributeProportionally(docDiscount, weights)

  const lines: ComputedLine[] = extended.map((e, i) => {
    const discountAmount = e.lineDiscount.plus(spread[i])
    const taxableBase = e.lineSubtotal.minus(discountAmount)
    const taxAmount = e.line.taxable && !rate.isZero() ? round2(taxableBase.times(rate)) : ZERO
    return {
      quantity: e.line.quantity,
      baseQuantity: e.baseQuantity,
      unitPrice: e.unitPrice,
      lineSubtotal: e.lineSubtotal,
      discountAmount,
      taxableBase,
      taxAmount,
      lineTotal: e.lineSubtotal.minus(discountAmount).plus(taxAmount),
    }
  })

  const subtotal = sum(lines.map((l) => l.lineSubtotal))
  const discountTotal = sum(lines.map((l) => l.discountAmount))
  const taxTotal = sum(lines.map((l) => l.taxAmount))

  return {
    lines,
    subtotal,
    discountTotal,
    taxTotal,
    total: subtotal.minus(discountTotal).plus(taxTotal),
  }
}

/**
 * The identity from docs/02 §M5, checked before a sale is allowed to commit.
 * A document that fails this is a bug we refuse to persist rather than discover
 * later in an AR report.
 */
export function assertTotalsIdentity(totals: SaleTotals): void {
  for (const [i, line] of totals.lines.entries()) {
    const expected = line.lineSubtotal.minus(line.discountAmount).plus(line.taxAmount)
    if (!line.lineTotal.equals(expected)) {
      throw new Error(`Line ${i + 1} total ${line.lineTotal} ≠ ${expected}`)
    }
  }
  const expectedTotal = totals.subtotal.minus(totals.discountTotal).plus(totals.taxTotal)
  if (!totals.total.equals(expectedTotal)) {
    throw new Error(`Sale total ${totals.total} ≠ ${expectedTotal}`)
  }
  const lineSum = sum(totals.lines.map((l) => l.lineTotal))
  if (!lineSum.equals(totals.total)) {
    throw new Error(`Sum of line totals ${lineSum} ≠ sale total ${totals.total}`)
  }
}

/** Terms → due date. COD is due the day it is sold (docs/02 §A5). */
const TERM_DAYS: Record<string, number> = { COD: 0, NET7: 7, NET15: 15, NET30: 30, NET60: 60 }

export function dueDateFor(occurredAt: Date, termsCode: string): Date {
  const days = TERM_DAYS[termsCode] ?? 0
  const due = new Date(occurredAt)
  due.setUTCDate(due.getUTCDate() + days)
  due.setUTCHours(0, 0, 0, 0)
  return due
}
