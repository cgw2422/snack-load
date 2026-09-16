import { describe, expect, it } from 'vitest'
import { assertTotalsIdentity, computeSaleTotals, dueDateFor } from '@/server/domain/saleMath'
import { sum, toAmountString } from '@/server/domain/money'

const TAX = '0.0725'

describe('sale totals', () => {
  it('reproduces the receipt from the product brief', () => {
    // Takis 3 cs @ 19.50, Monster 2 cs @ 33.50, Snickers 1 box @ 24.00,
    // Coke 2 cs @ 18.00 → 185.50, tax exempt.
    const totals = computeSaleTotals({
      taxRate: TAX,
      taxExempt: true,
      lines: [
        { quantity: 3, baseUnitsPerUom: 12, unitPrice: '19.50', taxable: true },
        { quantity: 2, baseUnitsPerUom: 24, unitPrice: '33.50', taxable: true },
        { quantity: 1, baseUnitsPerUom: 48, unitPrice: '24.00', taxable: true },
        { quantity: 2, baseUnitsPerUom: 24, unitPrice: '18.00', taxable: true },
      ],
    })

    expect(toAmountString(totals.subtotal)).toBe('185.50')
    expect(toAmountString(totals.taxTotal)).toBe('0.00')
    expect(toAmountString(totals.total)).toBe('185.50')
    expect(totals.lines.map((l) => toAmountString(l.lineTotal))).toEqual([
      '58.50', '67.00', '24.00', '36.00',
    ])
    assertTotalsIdentity(totals)
  })

  it('resolves base quantities alongside the money', () => {
    const totals = computeSaleTotals({
      taxRate: '0',
      taxExempt: false,
      lines: [{ quantity: 3, baseUnitsPerUom: 12, unitPrice: '19.50', taxable: true }],
    })
    expect(totals.lines[0].baseQuantity).toBe(36)
  })

  it('taxes each line and sums already-rounded values', () => {
    const totals = computeSaleTotals({
      taxRate: TAX,
      taxExempt: false,
      lines: [
        { quantity: 3, baseUnitsPerUom: 12, unitPrice: '19.50', taxable: true },
        { quantity: 2, baseUnitsPerUom: 24, unitPrice: '33.50', taxable: true },
      ],
    })

    // 58.50 × 0.0725 = 4.24125 → 4.24 ; 67.00 × 0.0725 = 4.8575 → 4.86
    expect(totals.lines.map((l) => toAmountString(l.taxAmount))).toEqual(['4.24', '4.86'])
    expect(toAmountString(totals.taxTotal)).toBe('9.10')
    expect(toAmountString(totals.total)).toBe('134.60')
    assertTotalsIdentity(totals)
  })

  it('leaves a non-taxable line untaxed even when the customer is not exempt', () => {
    const totals = computeSaleTotals({
      taxRate: TAX,
      taxExempt: false,
      lines: [
        { quantity: 1, baseUnitsPerUom: 1, unitPrice: '10.00', taxable: false },
        { quantity: 1, baseUnitsPerUom: 1, unitPrice: '10.00', taxable: true },
      ],
    })
    expect(toAmountString(totals.lines[0].taxAmount)).toBe('0.00')
    expect(toAmountString(totals.lines[1].taxAmount)).toBe('0.73')
  })

  it('applies a line discount before tax', () => {
    const totals = computeSaleTotals({
      taxRate: TAX,
      taxExempt: false,
      lines: [
        { quantity: 4, baseUnitsPerUom: 12, unitPrice: '19.50', discountAmount: '8.00', taxable: true },
      ],
    })
    // (78.00 − 8.00) × 0.0725 = 5.075 → 5.08
    expect(toAmountString(totals.lines[0].taxableBase)).toBe('70.00')
    expect(toAmountString(totals.lines[0].taxAmount)).toBe('5.08')
    expect(toAmountString(totals.total)).toBe('75.08')
    assertTotalsIdentity(totals)
  })

  it('spreads a document discount so the parts sum to the whole', () => {
    const totals = computeSaleTotals({
      taxRate: '0',
      taxExempt: false,
      documentDiscount: '10.00',
      lines: [
        { quantity: 1, baseUnitsPerUom: 1, unitPrice: '33.33', taxable: true },
        { quantity: 1, baseUnitsPerUom: 1, unitPrice: '33.33', taxable: true },
        { quantity: 1, baseUnitsPerUom: 1, unitPrice: '33.34', taxable: true },
      ],
    })
    expect(toAmountString(totals.discountTotal)).toBe('10.00')
    expect(toAmountString(totals.total)).toBe('90.00')
    assertTotalsIdentity(totals)
  })

  it('keeps Σ lines equal to the document total across awkward prices', () => {
    const prices = ['19.99', '2.33', '0.87', '13.71', '5.05', '41.29']
    const totals = computeSaleTotals({
      taxRate: '0.06375',
      taxExempt: false,
      lines: prices.map((unitPrice, i) => ({
        quantity: i + 1,
        baseUnitsPerUom: 12,
        unitPrice,
        taxable: true,
      })),
    })

    assertTotalsIdentity(totals)
    expect(toAmountString(sum(totals.lines.map((l) => l.lineTotal)))).toBe(
      toAmountString(totals.total),
    )
  })

  it('charges no tax when the customer is exempt, whatever the rate', () => {
    const totals = computeSaleTotals({
      taxRate: '0.15',
      taxExempt: true,
      lines: [{ quantity: 1, baseUnitsPerUom: 1, unitPrice: '100.00', taxable: true }],
    })
    expect(toAmountString(totals.taxTotal)).toBe('0.00')
    expect(toAmountString(totals.total)).toBe('100.00')
  })
})

describe('payment terms', () => {
  const sold = new Date('2026-09-09T14:30:00.000Z')

  it('makes a COD sale due the day it is sold', () => {
    expect(dueDateFor(sold, 'COD').toISOString()).toBe('2026-09-09T00:00:00.000Z')
  })

  it('counts calendar days for net terms', () => {
    expect(dueDateFor(sold, 'NET15').toISOString()).toBe('2026-09-24T00:00:00.000Z')
    expect(dueDateFor(sold, 'NET30').toISOString()).toBe('2026-10-09T00:00:00.000Z')
  })

  it('treats an unknown term as due immediately rather than never', () => {
    expect(dueDateFor(sold, 'NONSENSE').toISOString()).toBe('2026-09-09T00:00:00.000Z')
  })
})
