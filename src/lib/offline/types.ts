/**
 * The shapes the snapshot endpoints return (docs/05 §2).
 *
 * They live here, not beside the service that builds them, because the client
 * reads them and must not drag Prisma into its bundle to know what a cached
 * catalogue looks like. The service imports these and is typed by them, so the
 * two cannot drift.
 *
 * Money is a decimal string, as it is everywhere else on the wire.
 */

export type SnapshotStamp = {
  /** When the server produced this, ISO-8601. Every snapshot carries one. */
  asOf: string
}

export type CatalogUom = {
  id: string
  /** EACH, CASE… the same code the picker shows online. */
  code: string
  label: string
  baseUnitsPerUom: number
  /** List price. Customer and price-group overrides are resolved server-side. */
  price: string
  isDefaultSaleUom: boolean
}

export type CatalogItem = {
  productId: string
  sku: string
  name: string
  brand: string | null
  baseUomLabel: string
  taxable: boolean
  uoms: CatalogUom[]
}

export type CatalogSnapshot = SnapshotStamp & {
  locationId: string
  locationName: string
  items: CatalogItem[]
}

export type BalanceSnapshot = SnapshotStamp & {
  locationId: string
  locationName: string
  balances: { productId: string; quantity: number }[]
}
