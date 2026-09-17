import { describe, expect, it } from 'vitest'
import {
  assertCreditIdentity,
  creditForReturn,
  remainingReturnable,
  totalCredit,
  type OriginalLine,
} from '@/server/domain/returnMath'

/**
 * The arithmetic of a credit, pinned exactly (spec §5).
 *
 * Pure functions, so the awkward cases are cheap to state here rather than
 * discovering them through an integration test that had to sell something first.
 */

/** Four cases at $20, taxed at 7.25%: $80 of goods, $5.80 of tax. */
const sold: OriginalLine = {
  baseQuantity: 48,
  unitPrice: '20.0000',
  lineSubtotal: '80.00',
  discountAmount: '0.00',
  taxable: true,
  taxableAmount: '80.00',
  taxRateApplied: '0.0725',
  taxAmount: '5.80',
  lineTotal: '85.80',
  unitCostAtSale: '1.200000',
}

describe('creditForReturn', () => {
  it('credits a whole line exactly, with no proration drift', () => {
    const credit = creditForReturn(sold, 48)
    expect(credit.lineSubtotal).toBe('80.00')
    expect(credit.taxAmount).toBe('5.80')
    expect(credit.lineTotal).toBe('85.80')
    expect(credit.taxableAmount).toBe('80.00')
  })

  it('prorates the basis alongside the tax', () => {
    const credit = creditForReturn(sold, 12)
    expect(credit.lineSubtotal).toBe('20.00')
    expect(credit.taxableAmount).toBe('20.00')
    expect(credit.taxAmount).toBe('1.45')
    expect(credit.lineTotal).toBe('21.45')
  })

  it('carries the original rate rather than recomputing one', () => {
    // The rate is a fact about the sale, not an input to the credit. Deriving
    // it from the prorated figures would drift on the rounding, and looking it
    // up would use today's rate — which is the whole bug (docs/02 §M4).
    expect(creditForReturn(sold, 12).taxRateApplied).toBe('0.0725')
    expect(creditForReturn(sold, 1).taxRateApplied).toBe('0.0725')
  })

  it('keeps a taxable line taxable even when no tax was charged', () => {
    // An exempt buyer. Zero tax to reverse, but the goods were taxable and the
    // basis is still what an exemption report asks for.
    const exempt: OriginalLine = {
      ...sold,
      taxRateApplied: '0',
      taxAmount: '0.00',
      lineTotal: '80.00',
    }
    const credit = creditForReturn(exempt, 24)
    expect(credit.taxable).toBe(true)
    expect(credit.taxAmount).toBe('0.00')
    expect(credit.taxableAmount).toBe('40.00')
    expect(credit.lineTotal).toBe('40.00')
  })

  it('records a zero basis for goods that were never taxable', () => {
    const untaxed: OriginalLine = {
      ...sold,
      taxable: false,
      taxableAmount: '0.00',
      taxRateApplied: '0',
      taxAmount: '0.00',
      lineTotal: '80.00',
    }
    const credit = creditForReturn(untaxed, 24)
    expect(credit.taxable).toBe(false)
    expect(credit.taxableAmount).toBe('0.00')
  })

  it('refuses to credit more than was sold', () => {
    expect(() => creditForReturn(sold, 49)).toThrow(/more units than were sold/i)
    expect(() => creditForReturn(sold, 0)).toThrow(/at least one base unit/i)
  })

  it('adds up to a document that satisfies its own identity', () => {
    const lines = [creditForReturn(sold, 12), creditForReturn(sold, 7)]
    const totals = totalCredit(lines)
    expect(() => assertCreditIdentity(lines, totals)).not.toThrow()
    expect(totals.total).toBe('33.97')
  })
})

describe('remainingReturnable', () => {
  it('is what is left, and never negative', () => {
    expect(remainingReturnable(36, 0)).toBe(36)
    expect(remainingReturnable(36, 12)).toBe(24)
    expect(remainingReturnable(36, 36)).toBe(0)
    // A voided-and-reposted history could in principle overshoot; the answer is
    // still "nothing", not a negative allowance.
    expect(remainingReturnable(36, 48)).toBe(0)
  })
})
