import { describe, expect, it } from 'vitest'
import { lineMargin, resolvePrice } from '@/server/domain/pricing'
import { toAmountString } from '@/server/domain/money'

const CASE_UOM = 'uom-case'
const UNIT_UOM = 'uom-each'

describe('price resolution', () => {
  it('falls back to the list price when nothing else applies', () => {
    const r = resolvePrice({ productUomId: CASE_UOM, listPrice: '19.50' })
    expect(toAmountString(r.price)).toBe('19.50')
    expect(r.source).toBe('STANDARD')
  })

  it("prefers a customer's own price over the list price", () => {
    const r = resolvePrice({
      productUomId: CASE_UOM,
      listPrice: '19.50',
      customerPrices: [{ price: '18.75', productUomId: CASE_UOM }],
    })
    expect(toAmountString(r.price)).toBe('18.75')
    expect(r.source).toBe('CUSTOMER')
  })

  it('prefers a customer price over their price group', () => {
    const r = resolvePrice({
      productUomId: CASE_UOM,
      listPrice: '19.50',
      priceGroupPrices: [{ price: '19.00', productUomId: CASE_UOM }],
      customerPrices: [{ price: '18.75', productUomId: CASE_UOM }],
    })
    expect(toAmountString(r.price)).toBe('18.75')
  })

  it('uses the price group when the customer has no price of their own', () => {
    const r = resolvePrice({
      productUomId: CASE_UOM,
      listPrice: '19.50',
      priceGroupPrices: [{ price: '19.00', productUomId: CASE_UOM }],
    })
    expect(toAmountString(r.price)).toBe('19.00')
    expect(r.source).toBe('GROUP')
  })

  it('lets a promotion beat a negotiated customer price', () => {
    const r = resolvePrice({
      productUomId: CASE_UOM,
      listPrice: '19.50',
      customerPrices: [{ price: '18.75', productUomId: CASE_UOM }],
      promotions: [{ price: '16.99', productUomId: CASE_UOM }],
    })
    expect(toAmountString(r.price)).toBe('16.99')
    expect(r.source).toBe('PROMO')
  })

  it('lets a manual override beat everything, and says so', () => {
    const r = resolvePrice({
      productUomId: CASE_UOM,
      listPrice: '19.50',
      customerPrices: [{ price: '18.75', productUomId: CASE_UOM }],
      promotions: [{ price: '16.99', productUomId: CASE_UOM }],
      manualPrice: '15.00',
    })
    expect(toAmountString(r.price)).toBe('15.00')
    expect(r.source).toBe('MANUAL')
  })

  it('treats a manual price of zero as a deliberate giveaway, not a missing value', () => {
    const r = resolvePrice({ productUomId: CASE_UOM, listPrice: '19.50', manualPrice: 0 })
    expect(toAmountString(r.price)).toBe('0.00')
    expect(r.source).toBe('MANUAL')
  })

  it('ignores a price attached to a different unit of measure', () => {
    const r = resolvePrice({
      productUomId: CASE_UOM,
      listPrice: '19.50',
      customerPrices: [{ price: '2.10', productUomId: UNIT_UOM }],
    })
    expect(toAmountString(r.price)).toBe('19.50')
    expect(r.source).toBe('STANDARD')
  })

  it('prefers a price naming this UoM over one that applies to any', () => {
    const r = resolvePrice({
      productUomId: CASE_UOM,
      listPrice: '19.50',
      customerPrices: [
        { price: '19.10', productUomId: null },
        { price: '18.75', productUomId: CASE_UOM },
      ],
    })
    expect(toAmountString(r.price)).toBe('18.75')
  })

  it('ignores a price that has not started yet', () => {
    const r = resolvePrice({
      productUomId: CASE_UOM,
      listPrice: '19.50',
      asOf: new Date('2026-09-16T12:00:00Z'),
      customerPrices: [
        { price: '17.00', productUomId: CASE_UOM, effectiveFrom: new Date('2026-10-01T00:00:00Z') },
      ],
    })
    expect(toAmountString(r.price)).toBe('19.50')
  })

  it('ignores a price that has expired', () => {
    const r = resolvePrice({
      productUomId: CASE_UOM,
      listPrice: '19.50',
      asOf: new Date('2026-09-16T12:00:00Z'),
      customerPrices: [
        { price: '17.00', productUomId: CASE_UOM, effectiveTo: new Date('2026-09-01T00:00:00Z') },
      ],
    })
    expect(toAmountString(r.price)).toBe('19.50')
  })

  it('takes the most recently effective of two live prices', () => {
    const r = resolvePrice({
      productUomId: CASE_UOM,
      listPrice: '19.50',
      asOf: new Date('2026-09-16T12:00:00Z'),
      customerPrices: [
        { price: '18.75', productUomId: CASE_UOM, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
        { price: '18.25', productUomId: CASE_UOM, effectiveFrom: new Date('2026-09-01T00:00:00Z') },
      ],
    })
    expect(toAmountString(r.price)).toBe('18.25')
  })
})

describe('line margin', () => {
  it('brings a per-UoM price and a per-base-unit cost onto the same footing', () => {
    // A case of 12 at 19.50, costing 1.20 per bag → cost 14.40, profit 5.10.
    const { cost, profit, marginPercent } = lineMargin({
      unitPrice: '19.50',
      baseUnitsPerUom: 12,
      costPerBaseUnit: '1.200000',
    })
    expect(toAmountString(cost)).toBe('14.40')
    expect(toAmountString(profit)).toBe('5.10')
    expect(marginPercent?.toFixed(2)).toBe('26.15')
  })

  it('reports a loss when a price is overridden below cost', () => {
    const { profit } = lineMargin({
      unitPrice: '12.00',
      baseUnitsPerUom: 12,
      costPerBaseUnit: '1.200000',
    })
    expect(profit.isNegative()).toBe(true)
    expect(toAmountString(profit)).toBe('-2.40')
  })

  it('declines to divide by a zero price', () => {
    expect(lineMargin({ unitPrice: '0', baseUnitsPerUom: 12, costPerBaseUnit: '1.2' }).marginPercent)
      .toBeNull()
  })
})
