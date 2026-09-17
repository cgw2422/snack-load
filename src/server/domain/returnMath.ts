import { m, round2, toAmountString } from './money'
import type Decimal from 'decimal.js'

/**
 * The arithmetic of a return (spec §5).
 *
 * A credit is a *proportion of what was originally charged*, never a fresh
 * calculation against today's prices and today's tax rules. If a store was
 * billed $100 of merchandise and $7.25 of tax, and half the merchandise comes
 * back, the credit is $50 and $3.63 — not $50 plus whatever the current rate
 * happens to be, and not $50 plus tax recomputed against a customer who has
 * since become tax-exempt.
 *
 * Everything here is pure. The service decides what is being returned; this
 * decides what it is worth.
 */

export type OriginalLine = {
  /** Base units on the original sale line. Never zero. */
  baseQuantity: number
  unitPrice: string
  lineSubtotal: string
  discountAmount: string
  /** Whether the line was taxable when it was sold, not whether it is today. */
  taxable: boolean
  /** The basis tax was charged on at the time of sale. */
  taxableAmount: string
  /** The rate applied at the time of sale, e.g. "0.0725". */
  taxRateApplied: string
  taxAmount: string
  lineTotal: string
  unitCostAtSale: string
}

export type CreditedLine = {
  /** Base units being credited. */
  baseQuantity: number
  unitPrice: string
  lineSubtotal: string
  discountAmount: string
  taxable: boolean
  /** The share of the original taxable basis being reversed. */
  taxableAmount: string
  /** Carried through unchanged: a reversal uses the ORIGINAL rate, always. */
  taxRateApplied: string
  taxAmount: string
  lineTotal: string
  unitCostAtSale: string
}

/**
 * Prorates one original sale line down to the quantity coming back.
 *
 * Returning the whole line credits the whole line exactly — no rounding drift
 * on the common case, which matters because "I returned everything and you
 * credited me a penny short" is a phone call nobody wants.
 */
export function creditForReturn(original: OriginalLine, returnedBaseUnits: number): CreditedLine {
  if (returnedBaseUnits <= 0) {
    throw new Error('A credited line must cover at least one base unit.')
  }
  if (returnedBaseUnits > original.baseQuantity) {
    throw new Error('Cannot credit more units than were sold on that line.')
  }

  if (returnedBaseUnits === original.baseQuantity) {
    return {
      baseQuantity: returnedBaseUnits,
      unitPrice: original.unitPrice,
      lineSubtotal: toAmountString(original.lineSubtotal),
      discountAmount: toAmountString(original.discountAmount),
      taxable: original.taxable,
      taxableAmount: toAmountString(original.taxableAmount),
      taxRateApplied: original.taxRateApplied,
      taxAmount: toAmountString(original.taxAmount),
      lineTotal: toAmountString(original.lineTotal),
      unitCostAtSale: original.unitCostAtSale,
    }
  }

  const share = m(returnedBaseUnits).dividedBy(original.baseQuantity)
  const subtotal = round2(m(original.lineSubtotal).times(share))
  const discount = round2(m(original.discountAmount).times(share))
  // Tax follows the merchandise it was charged on. Prorating the ORIGINAL tax
  // is what keeps a reversal correct when the rate, the customer's exemption or
  // the product's taxability has changed since (spec §5).
  const tax = round2(m(original.taxAmount).times(share))
  const taxableAmount = round2(m(original.taxableAmount).times(share))

  return {
    baseQuantity: returnedBaseUnits,
    unitPrice: original.unitPrice,
    lineSubtotal: toAmountString(subtotal),
    discountAmount: toAmountString(discount),
    taxable: original.taxable,
    taxableAmount: toAmountString(taxableAmount),
    // The rate is NOT prorated and NOT re-looked-up. Half the goods coming back
    // reverses half the tax at the rate that was charged, whatever the rate is
    // today (spec §5).
    taxRateApplied: original.taxRateApplied,
    taxAmount: toAmountString(tax),
    lineTotal: toAmountString(subtotal.minus(discount).plus(tax)),
    unitCostAtSale: original.unitCostAtSale,
  }
}

export type CreditTotals = {
  subtotal: string
  discountTotal: string
  taxTotal: string
  total: string
}

export function totalCredit(lines: CreditedLine[]): CreditTotals {
  const add = (pick: (line: CreditedLine) => string): Decimal =>
    lines.reduce((total, line) => total.plus(m(pick(line))), m(0))

  const subtotal = add((l) => l.lineSubtotal)
  const discountTotal = add((l) => l.discountAmount)
  const taxTotal = add((l) => l.taxAmount)

  return {
    subtotal: toAmountString(subtotal),
    discountTotal: toAmountString(discountTotal),
    taxTotal: toAmountString(taxTotal),
    total: toAmountString(subtotal.minus(discountTotal).plus(taxTotal)),
  }
}

/**
 * The identity a credit memo has to satisfy, checked before anything is
 * written. Same discipline as `assertTotalsIdentity` on a sale: a document that
 * does not add up must never reach the database (docs/02 §M3).
 */
export function assertCreditIdentity(lines: CreditedLine[], totals: CreditTotals): void {
  for (const [index, line] of lines.entries()) {
    const expected = m(line.lineSubtotal).minus(line.discountAmount).plus(line.taxAmount)
    if (!m(line.lineTotal).equals(expected)) {
      throw new Error(
        `Credit line ${index + 1} does not add up: ${line.lineTotal} should be ${toAmountString(expected)}.`,
      )
    }
  }

  const recomputed = totalCredit(lines)
  if (
    recomputed.subtotal !== totals.subtotal ||
    recomputed.discountTotal !== totals.discountTotal ||
    recomputed.taxTotal !== totals.taxTotal ||
    recomputed.total !== totals.total
  ) {
    throw new Error('Credit totals do not match the sum of their lines.')
  }
}

/**
 * How many base units of a sale line may still be returned.
 *
 * Returns already posted against the line reduce it; a voided return does not
 * count, because its goods and its credit were both unwound (spec §1).
 */
export function remainingReturnable(soldBaseUnits: number, alreadyReturned: number): number {
  return Math.max(0, soldBaseUnits - alreadyReturned)
}
