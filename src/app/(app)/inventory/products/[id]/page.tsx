import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound as nextNotFound } from 'next/navigation'
import { ArrowLeft, Boxes, Warehouse, Truck } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { getProduct } from '@/server/services/product.service'
import { listLedger } from '@/server/services/receiving.service'
import { lineMargin } from '@/server/domain/pricing'
import { formatMoney } from '@/server/domain/money'
import { formatQuantityLong } from '@/server/domain/uom'
import { isAppError } from '@/lib/errors'
import { Card, CardHeader } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { LedgerList } from '@/components/stock/LedgerList'

export const metadata: Metadata = { title: 'Product' }

export default async function ProductPage(props: PageProps<'/inventory/products/[id]'>) {
  const ctx = await requireAuth()
  const { id } = await props.params

  let product
  try {
    product = await getProduct(ctx, id)
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') nextNotFound()
    throw error
  }

  const ledger = can(ctx, 'inventory:read')
    ? await listLedger(ctx, { productId: product.id, limit: 20 })
    : []

  const currency = ctx.organization.currency
  const showCost = can(ctx, 'report:financial') || can(ctx, 'product:update')

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <Link
        href="/inventory/products"
        className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-navy-600 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Products
      </Link>

      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold text-ink">{product.name}</h1>
            <p className="mt-0.5 text-sm text-ink-muted">
              SKU {product.sku}
              {product.upc ? ` · UPC ${product.upc}` : ''}
            </p>
            <p className="text-sm text-ink-muted">
              {[product.brand, product.categoryName, product.supplierName]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {product.active ? <Pill tone="cash">Active</Pill> : <Pill>Inactive</Pill>}
            {product.taxable ? <Pill tone="navy">Taxable</Pill> : <Pill>Tax free</Pill>}
          </div>
        </div>

        {product.description ? (
          <p className="mt-3 border-t border-line pt-3 text-sm text-ink-muted">
            {product.description}
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Units and pricing" />
        <ul className="divide-y divide-line">
          {product.uoms.map((uom) => {
            const margin = showCost
              ? lineMargin({
                  unitPrice: uom.price,
                  baseUnitsPerUom: uom.baseUnitsPerUom,
                  costPerBaseUnit: product.costPerBaseUnit,
                })
              : null

            return (
              <li key={uom.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-ink">{uom.label}</span>
                    {uom.isDefaultSaleUom ? <Pill tone="flame">Default</Pill> : null}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {uom.baseUnitsPerUom === 1
                      ? `One ${product.baseUomLabel.toLowerCase()}`
                      : `${uom.baseUnitsPerUom} ${product.baseUomLabel.toLowerCase()}s`}
                    {uom.barcode ? ` · ${uom.barcode}` : ''}
                  </span>
                </span>

                <span className="shrink-0 text-right">
                  <span className="tnum block text-sm font-bold text-ink">
                    {formatMoney(uom.price, currency)}
                  </span>
                  {margin ? (
                    <span
                      className={`tnum block text-xs font-medium ${
                        margin.profit.isNegative() ? 'text-stop-600' : 'text-cash-600'
                      }`}
                    >
                      {formatMoney(margin.profit, currency)}
                      {margin.marginPercent ? ` · ${margin.marginPercent.toFixed(1)}%` : ''}
                    </span>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>

        {showCost ? (
          <p className="border-t border-line px-4 py-2.5 text-xs text-ink-muted">
            Cost {formatMoney(product.costPerBaseUnit, currency)} per{' '}
            {product.baseUomLabel.toLowerCase()} · margins shown against that cost
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Stock on hand"
          action={
            <span
              className={`tnum text-sm font-bold ${
                product.belowReorderPoint ? 'text-alert-600' : 'text-ink'
              }`}
            >
              {product.onHandLabel}
            </span>
          }
        />

        {product.stockByLocation.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-ink-muted">
            Nothing on hand anywhere. Receive stock to get started.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {product.stockByLocation.map((location) => (
              <li key={location.locationId} className="flex items-center gap-3 px-4 py-2.5">
                {location.kind === 'WAREHOUSE' ? (
                  <Warehouse className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                ) : (
                  <Truck className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {location.locationName}
                </span>
                <span className="tnum shrink-0 text-sm font-semibold text-ink">
                  {formatQuantityLong(location.quantity, product.unitsPerCase, {
                    package: 'case',
                    unit: product.baseUomLabel.toLowerCase(),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}

        {product.reorderPointBaseUnits > 0 ? (
          <p className="flex items-center gap-1.5 border-t border-line px-4 py-2.5 text-xs text-ink-muted">
            <Boxes className="size-3.5" aria-hidden="true" />
            Reorder at{' '}
            {formatQuantityLong(product.reorderPointBaseUnits, product.unitsPerCase, {
              package: 'case',
              unit: product.baseUomLabel.toLowerCase(),
            })}
          </p>
        ) : null}
      </Card>

      {ledger.length > 0 ? (
        <Card>
          <CardHeader title="Movement history" />
          <LedgerList entries={ledger} showProduct={false} />
        </Card>
      ) : null}

      {product.notes ? (
        <Card className="p-4">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-ink-subtle">Notes</h2>
          <p className="mt-1 whitespace-pre-line text-sm text-ink">{product.notes}</p>
        </Card>
      ) : null}
    </div>
  )
}
