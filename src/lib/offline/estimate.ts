import { computeSaleTotals } from '@/server/domain/saleMath'
import { toAmountString } from '@/server/domain/money'
import type { BalanceSnapshot, CatalogItem, CatalogSnapshot } from './types'

/**
 * What the runner is shown when the server cannot be asked (docs/05 §3).
 *
 * This is an **estimate**, and the word is load-bearing. It is computed from
 * the catalogue this device cached — list prices, the customer's tax regime as
 * it stood when the screen loaded — and it is never sent as money. It rides on
 * the queued entry as `clientEstimate` for one purpose: so that when the sale
 * is priced for real on arrival, the runner can be told the total moved rather
 * than discovering it on a statement.
 *
 * It deliberately reuses `computeSaleTotals`, the same pure function the server
 * prices with. Two implementations of the same arithmetic would disagree
 * eventually, and every disagreement would surface as a spurious "the price
 * changed" that trains runners to ignore the real ones.
 *
 * What it cannot know, and does not pretend to:
 *
 *  - customer-specific and price-group prices, which live server-side,
 *  - a price somebody in the office changed since the catalogue was cached,
 *  - stock another runner has sold off the same truck since.
 */

/**
 * Only what the sell screen renders.
 *
 * Deliberately not the server's `PricedLine`: the extra fields on that one —
 * the tax basis, the rate actually applied, the price source — are snapshotted
 * onto a posted sale, and an estimate has no business carrying look-alikes of
 * them.
 */
export type EstimatedLine = {
  productId: string
  productUomId: string
  productName: string
  uomLabel: string
  quantity: number
  baseQuantity: number
  unitPrice: string
  lineTotal: string
  taxable: boolean
  /** From the cached balance snapshot, so it is as old as that snapshot is. */
  available: number
  priceSource: 'ESTIMATE'
}

export type Estimate = {
  lines: EstimatedLine[]
  subtotal: string
  discountTotal: string
  taxTotal: string
  total: string
  taxExempt: boolean
  sellingLocationId: string
  sellingLocationName: string
  /** Products in the cart that this device has no cached record of. */
  unknown: string[]
}

export function estimateCart(input: {
  lines: { productId: string; productUomId: string; quantity: number }[]
  catalog: CatalogSnapshot
  balances: BalanceSnapshot | null
  taxRate: string
  taxExempt: boolean
}): Estimate | null {
  if (input.lines.length === 0) return null

  const byProduct = new Map<string, CatalogItem>(
    input.catalog.items.map((item) => [item.productId, item]),
  )
  const onHand = new Map<string, number>(
    (input.balances?.balances ?? []).map((row) => [row.productId, row.quantity]),
  )

  const unknown: string[] = []
  const resolved: { line: (typeof input.lines)[number]; item: CatalogItem; uom: CatalogItem['uoms'][number] }[] = []

  for (const line of input.lines) {
    const item = byProduct.get(line.productId)
    const uom = item?.uoms.find((candidate) => candidate.id === line.productUomId)
    if (!item || !uom) {
      unknown.push(item?.name ?? line.productId)
      continue
    }
    resolved.push({ line, item, uom })
  }

  // A cart this device cannot price at all is better shown as unpriced than as
  // a total that silently omits a line.
  if (resolved.length === 0) {
    return {
      lines: [], subtotal: '0.00', discountTotal: '0.00', taxTotal: '0.00', total: '0.00',
      taxExempt: input.taxExempt,
      sellingLocationId: input.catalog.locationId,
      sellingLocationName: input.catalog.locationName,
      unknown,
    }
  }

  const totals = computeSaleTotals({
    taxRate: input.taxRate,
    taxExempt: input.taxExempt,
    documentDiscount: 0,
    lines: resolved.map((entry) => ({
      quantity: entry.line.quantity,
      baseUnitsPerUom: entry.uom.baseUnitsPerUom,
      unitPrice: entry.uom.price,
      discountAmount: 0,
      taxable: entry.item.taxable,
    })),
  })

  return {
    lines: resolved.map((entry, index) => {
      const computed = totals.lines[index]
      return {
        productId: entry.line.productId,
        productUomId: entry.uom.id,
        productName: entry.item.name,
        uomLabel: entry.uom.label,
        quantity: entry.line.quantity,
        baseQuantity: computed.baseQuantity,
        unitPrice: toAmountString(computed.unitPrice),
        lineTotal: toAmountString(computed.lineTotal),
        taxable: entry.item.taxable,
        available: onHand.get(entry.line.productId) ?? 0,
        priceSource: 'ESTIMATE',
      }
    }),
    subtotal: toAmountString(totals.subtotal),
    discountTotal: toAmountString(totals.discountTotal),
    taxTotal: toAmountString(totals.taxTotal),
    total: toAmountString(totals.total),
    taxExempt: input.taxExempt,
    sellingLocationId: input.catalog.locationId,
    sellingLocationName: input.catalog.locationName,
    unknown,
  }
}
