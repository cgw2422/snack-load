export type ProductHit = {
  id: string
  sku: string
  name: string
  brand: string | null
  baseUomLabel: string
  unitsPerCase: number
  casePrice: string | null
  unitPrice: string
  costPerBaseUnit: string
  onHandBaseUnits: number
  onHand?: number
}

export type ProductUomOption = {
  id: string
  code: string
  label: string
  baseUnitsPerUom: number
  price: string
  isDefaultSaleUom: boolean
}

export type StockLine = {
  /** Stable key for React; not sent to the server. */
  key: string
  productId: string
  productName: string
  sku: string
  baseUomLabel: string
  uoms: ProductUomOption[]
  productUomId: string
  quantity: number
  /** Only receiving collects a cost. */
  unitCost?: string
  onHand: number
}
