import type { ProductHit, ProductUomOption } from '@/components/stock/types'
import type { BalanceSnapshot, CatalogSnapshot } from './types'

/**
 * Finding a product with no signal (docs/05 §2).
 *
 * The same shape `/api/v1/products/search` returns, built from what this device
 * cached, so the picker renders one exactly like the other. Two honest gaps:
 *
 *  - Only what is on the truck. A runner cannot sell what they are not
 *    carrying, and that is the whole catalogue this device was given.
 *  - No cost. `costPerBaseUnit` is a purchasing figure; the sell screen has no
 *    use for it and a cached copy of it is one more stale number to explain.
 */
export function searchCachedCatalog(
  catalog: CatalogSnapshot,
  balances: BalanceSnapshot | null,
  term: string,
  limit = 12,
): ProductHit[] {
  const needle = term.trim().toLowerCase()
  if (needle.length === 0) return []

  const onHand = new Map((balances?.balances ?? []).map((row) => [row.productId, row.quantity]))

  return catalog.items
    .filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.sku.toLowerCase().includes(needle) ||
        (item.brand?.toLowerCase().includes(needle) ?? false),
    )
    .slice(0, limit)
    .map((item) => {
      const caseUom = item.uoms.find((uom) => uom.baseUnitsPerUom > 1)
      const baseUom = item.uoms.find((uom) => uom.baseUnitsPerUom === 1)
      const quantity = onHand.get(item.productId) ?? 0

      return {
        id: item.productId,
        sku: item.sku,
        name: item.name,
        brand: item.brand,
        baseUomLabel: item.baseUomLabel,
        unitsPerCase: caseUom?.baseUnitsPerUom ?? 1,
        casePrice: caseUom?.price ?? null,
        unitPrice: baseUom?.price ?? caseUom?.price ?? '0.00',
        costPerBaseUnit: '0',
        onHandBaseUnits: quantity,
        onHand: quantity,
      }
    })
}

export function cachedUoms(catalog: CatalogSnapshot, productId: string): ProductUomOption[] {
  const item = catalog.items.find((candidate) => candidate.productId === productId)
  return (item?.uoms ?? []).map((uom) => ({
    id: uom.id,
    code: uom.code,
    label: uom.label,
    baseUnitsPerUom: uom.baseUnitsPerUom,
    price: uom.price,
    isDefaultSaleUom: uom.isDefaultSaleUom,
  }))
}
