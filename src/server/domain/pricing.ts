import type { Decimal } from 'decimal.js'
import { m } from './money'

/**
 * Price resolution (docs/01 §3).
 *
 * The order is defined once, here, as a pure function — so the sales screen, a
 * quote, an import preview and a future native client cannot disagree about what
 * a store pays:
 *
 *   manual override → promotion → customer price → price-group price → list price
 *
 * A case price is never derived from the unit price. Distributors price cases
 * below the unit multiple on purpose, and the resolver must not fight that
 * (docs/02 §Q4).
 */

export type PriceSource = 'STANDARD' | 'GROUP' | 'CUSTOMER' | 'PROMO' | 'MANUAL'

export type PriceCandidate = {
  price: string | number | Decimal
  /** Null means open-ended. Both bounds are inclusive of `from`, exclusive of `to`. */
  effectiveFrom?: Date | null
  effectiveTo?: Date | null
  /** Null matches any UoM; a value matches only that UoM. */
  productUomId?: string | null
}

export type ResolvePriceInput = {
  productUomId: string
  /** The product's list price for this UoM — the floor of the resolution chain. */
  listPrice: string | number | Decimal
  customerPrices?: PriceCandidate[]
  priceGroupPrices?: PriceCandidate[]
  promotions?: PriceCandidate[]
  /** Set only when someone with `price:override` has typed a price. */
  manualPrice?: string | number | Decimal | null
  asOf?: Date
}

export type ResolvedPrice = {
  price: Decimal
  source: PriceSource
}

function isEffective(candidate: PriceCandidate, asOf: Date): boolean {
  if (candidate.effectiveFrom && candidate.effectiveFrom.getTime() > asOf.getTime()) return false
  if (candidate.effectiveTo && candidate.effectiveTo.getTime() <= asOf.getTime()) return false
  return true
}

/**
 * Picks the best candidate for a UoM: one naming this UoM explicitly beats one
 * that applies to any UoM, and among equals the most recently effective wins.
 */
function best(
  candidates: PriceCandidate[] | undefined,
  productUomId: string,
  asOf: Date,
): Decimal | null {
  if (!candidates?.length) return null

  const usable = candidates
    .filter((c) => isEffective(c, asOf))
    .filter((c) => c.productUomId == null || c.productUomId === productUomId)

  if (usable.length === 0) return null

  usable.sort((a, b) => {
    const specificity =
      (b.productUomId === productUomId ? 1 : 0) - (a.productUomId === productUomId ? 1 : 0)
    if (specificity !== 0) return specificity
    return (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0)
  })

  return m(usable[0].price)
}

export function resolvePrice(input: ResolvePriceInput): ResolvedPrice {
  const asOf = input.asOf ?? new Date()

  if (input.manualPrice !== null && input.manualPrice !== undefined) {
    return { price: m(input.manualPrice), source: 'MANUAL' }
  }

  const promo = best(input.promotions, input.productUomId, asOf)
  if (promo) return { price: promo, source: 'PROMO' }

  const customer = best(input.customerPrices, input.productUomId, asOf)
  if (customer) return { price: customer, source: 'CUSTOMER' }

  const group = best(input.priceGroupPrices, input.productUomId, asOf)
  if (group) return { price: group, source: 'GROUP' }

  return { price: m(input.listPrice), source: 'STANDARD' }
}

/**
 * Margin on a line, for the profitability reports and for warning a runner who
 * is about to override a price below cost.
 *
 * Cost is per BASE unit; price is per UoM. Both have to be brought to the same
 * footing before they can be compared, which is exactly the mistake this
 * function exists to stop anyone making inline.
 */
export function lineMargin(args: {
  unitPrice: string | number | Decimal
  baseUnitsPerUom: number
  costPerBaseUnit: string | number | Decimal
}): { cost: Decimal; profit: Decimal; marginPercent: Decimal | null } {
  const price = m(args.unitPrice)
  const cost = m(args.costPerBaseUnit).times(args.baseUnitsPerUom)
  const profit = price.minus(cost)
  return {
    cost,
    profit,
    marginPercent: price.isZero() ? null : profit.dividedBy(price).times(100),
  }
}
