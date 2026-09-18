import { describe, expect, it } from 'vitest'
import { estimateCart } from '@/lib/offline/estimate'
import { computeSaleTotals } from '@/server/domain/saleMath'
import { toAmountString } from '@/server/domain/money'
import type { BalanceSnapshot, CatalogSnapshot } from '@/lib/offline/types'

/**
 * The number a runner is shown with no signal (docs/05 §3).
 *
 * It is an estimate and it is labelled as one, but it still has to be *money*:
 * computed in decimals, rounded where the server rounds, and identical to what
 * the server would produce from the same prices. A client that quietly
 * disagreed with the server by a cent would make every queued sale report
 * itself as re-priced, and a runner who sees that warning on every sale stops
 * reading it.
 */

const catalog: CatalogSnapshot = {
  asOf: '2026-09-18T12:00:00Z',
  locationId: 'loc-truck-2',
  locationName: 'Truck #2',
  items: [
    {
      productId: 'p-takis',
      sku: 'TAK-FUE',
      name: 'Takis Fuego',
      brand: 'Barcel',
      baseUomLabel: 'Bag',
      taxable: true,
      uoms: [
        { id: 'u-takis-bag', label: 'Bag', baseUnitsPerUom: 1, price: '1.99', isDefaultSaleUom: false },
        { id: 'u-takis-case', label: 'Case of 12', baseUnitsPerUom: 12, price: '20.00', isDefaultSaleUom: true },
      ],
    },
    {
      productId: 'p-water',
      sku: 'WTR-24',
      name: 'Spring Water 24pk',
      brand: null,
      baseUomLabel: 'Bottle',
      taxable: false,
      uoms: [
        { id: 'u-water-case', label: 'Case of 24', baseUnitsPerUom: 24, price: '9.49', isDefaultSaleUom: true },
      ],
    },
  ],
}

const balances: BalanceSnapshot = {
  asOf: '2026-09-18T12:00:00Z',
  locationId: 'loc-truck-2',
  locationName: 'Truck #2',
  balances: [
    { productId: 'p-takis', quantity: 36 },
    { productId: 'p-water', quantity: 48 },
  ],
}

const CART = [
  { productId: 'p-takis', productUomId: 'u-takis-case', quantity: 3 },
  { productId: 'p-water', productUomId: 'u-water-case', quantity: 2 },
]

describe('pricing a cart from what the phone cached', () => {
  it('agrees with the server’s own arithmetic to the cent', () => {
    const estimate = estimateCart({
      lines: CART, catalog, balances, taxRate: '0.0725', taxExempt: false,
    })!

    // The same pure function the service prices with, given the same inputs.
    const server = computeSaleTotals({
      taxRate: '0.0725',
      taxExempt: false,
      documentDiscount: 0,
      lines: [
        { quantity: 3, baseUnitsPerUom: 12, unitPrice: '20.00', taxable: true },
        { quantity: 2, baseUnitsPerUom: 24, unitPrice: '9.49', taxable: false },
      ],
    })

    expect(estimate.subtotal).toBe(toAmountString(server.subtotal))
    expect(estimate.taxTotal).toBe(toAmountString(server.taxTotal))
    expect(estimate.total).toBe(toAmountString(server.total))

    // 60.00 + 18.98, tax on the taxable line only.
    expect(estimate.subtotal).toBe('78.98')
    expect(estimate.taxTotal).toBe('4.35')
    expect(estimate.total).toBe('83.33')
  })

  it('charges no tax to an exempt account', () => {
    const estimate = estimateCart({
      lines: CART, catalog, balances, taxRate: '0.0725', taxExempt: true,
    })!

    expect(estimate.taxTotal).toBe('0.00')
    expect(estimate.total).toBe('78.98')
    expect(estimate.taxExempt).toBe(true)
  })

  it('counts a case as its base units, so the stock warning is comparable', () => {
    const estimate = estimateCart({
      lines: [{ productId: 'p-takis', productUomId: 'u-takis-case', quantity: 4 }],
      catalog, balances, taxRate: '0', taxExempt: false,
    })!

    expect(estimate.lines[0].baseQuantity).toBe(48)
    expect(estimate.lines[0].available).toBe(36)
  })

  it('reports nothing on hand when it has no balance snapshot to go on', () => {
    const estimate = estimateCart({
      lines: CART, catalog, balances: null, taxRate: '0', taxExempt: false,
    })!

    expect(estimate.lines.every((line) => line.available === 0)).toBe(true)
  })

  it('names what it cannot price rather than totalling around it', () => {
    const estimate = estimateCart({
      lines: [
        ...CART,
        { productId: 'p-unknown', productUomId: 'u-unknown', quantity: 5 },
      ],
      catalog, balances, taxRate: '0', taxExempt: false,
    })!

    expect(estimate.unknown).toEqual(['p-unknown'])
    // The screen refuses checkout while `unknown` is non-empty, so the total
    // being short of a line is never presented as the price of the cart.
    expect(estimate.lines).toHaveLength(2)
  })

  it('gives no total at all when it knows none of the cart', () => {
    const estimate = estimateCart({
      lines: [{ productId: 'p-unknown', productUomId: 'u-unknown', quantity: 1 }],
      catalog, balances, taxRate: '0', taxExempt: false,
    })!

    expect(estimate.total).toBe('0.00')
    expect(estimate.lines).toEqual([])
    expect(estimate.unknown).toHaveLength(1)
  })

  it('has nothing to say about an empty cart', () => {
    expect(
      estimateCart({ lines: [], catalog, balances, taxRate: '0', taxExempt: false }),
    ).toBeNull()
  })

  it('never produces a float', () => {
    const estimate = estimateCart({
      lines: [{ productId: 'p-takis', productUomId: 'u-takis-bag', quantity: 7 }],
      catalog, balances, taxRate: '0.0725', taxExempt: false,
    })!

    for (const value of [estimate.subtotal, estimate.taxTotal, estimate.total]) {
      expect(typeof value).toBe('string')
      expect(value).toMatch(/^-?\d+\.\d{2}$/)
    }
    // 7 × 1.99 = 13.93; 13.93 × 0.0725 = 1.009925 → 1.01.
    expect(estimate.subtotal).toBe('13.93')
    expect(estimate.taxTotal).toBe('1.01')
    expect(estimate.total).toBe('14.94')
  })
})
