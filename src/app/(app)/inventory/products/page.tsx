import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ChevronRight, TriangleAlert, Upload } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { listProducts } from '@/server/services/product.service'
import { listQuerySchema } from '@/lib/schemas/catalog'
import { formatMoney } from '@/server/domain/money'
import { Card, EmptyState } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { SearchField } from '@/components/ui/SearchField'
import { Pagination } from '@/components/ui/Pagination'
import { ButtonLink } from '@/components/ui/Button'

export const metadata: Metadata = { title: 'Products' }

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const ctx = await requireAuth()
  if (!can(ctx, 'product:read')) redirect('/')

  const raw = await searchParams
  const query = listQuerySchema.parse({ ...raw, pageSize: raw.pageSize ?? 50 })
  const { items, total, page, pageCount } = await listProducts(ctx, query)
  const currency = ctx.organization.currency

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-ink">Products</h1>
          <p className="text-sm text-ink-muted">What you buy, stock and sell.</p>
        </div>
        {can(ctx, 'product:import') ? (
          <ButtonLink href="/inventory/products/import" size="sm" variant="secondary">
            <Upload className="size-4" aria-hidden="true" />
            Import
          </ButtonLink>
        ) : null}
      </div>

      <SearchField placeholder="Search name, SKU or barcode" />

      <FilterTabs status={query.status} searchParams={raw} />

      <Card>
        {items.length === 0 ? (
          <EmptyState
            title={query.search ? 'Nothing matches that' : 'No products yet'}
            description={
              query.search
                ? 'Try a different name, SKU or barcode.'
                : 'Import your catalog from a spreadsheet to get started.'
            }
            action={
              can(ctx, 'product:import') && !query.search ? (
                <ButtonLink href="/inventory/products/import" size="sm" variant="secondary">
                  Import products
                </ButtonLink>
              ) : null
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((product) => (
              <li key={product.id}>
                <Link
                  href={`/inventory/products/${product.id}`}
                  className="flex min-h-touch items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-ink">{product.name}</span>
                      {!product.active ? <Pill>Inactive</Pill> : null}
                    </span>
                    <span className="block truncate text-xs text-ink-muted">
                      SKU {product.sku}
                      {product.brand ? ` · ${product.brand}` : ''}
                      {product.categoryName ? ` · ${product.categoryName}` : ''}
                    </span>
                  </span>

                  <span className="w-28 shrink-0 text-right">
                    <span className="tnum block text-sm font-bold text-ink">
                      {product.casePrice
                        ? `${formatMoney(product.casePrice, currency)} / case`
                        : formatMoney(product.unitPrice, currency)}
                    </span>
                    <span
                      className={`tnum block text-xs font-medium ${
                        product.belowReorderPoint ? 'text-alert-600' : 'text-ink-muted'
                      }`}
                    >
                      {product.belowReorderPoint ? (
                        <TriangleAlert className="mr-0.5 inline size-3" aria-hidden="true" />
                      ) : null}
                      {product.onHandLabel}
                    </span>
                  </span>

                  <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}

        <Pagination
          page={page}
          pageCount={pageCount}
          total={total}
          noun="products"
          searchParams={raw}
        />
      </Card>
    </div>
  )
}

function FilterTabs({
  status,
  searchParams,
}: {
  status: string
  searchParams: Record<string, string | undefined>
}) {
  const options = [
    { value: 'active', label: 'Active' },
    { value: 'inactive', label: 'Inactive' },
    { value: 'all', label: 'All' },
  ]

  return (
    <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1">
      {options.map((option) => {
        const query = new URLSearchParams(
          Object.entries({ ...searchParams, status: option.value, page: undefined }).filter(
            ([, v]) => v,
          ) as [string, string][],
        )
        const active = status === option.value
        return (
          <Link
            key={option.value}
            href={`?${query}`}
            aria-current={active ? 'true' : undefined}
            className={`flex h-9 shrink-0 items-center rounded-full px-3.5 text-sm font-semibold transition-colors ${
              active
                ? 'bg-navy-800 text-white'
                : 'bg-surface-raised text-ink-muted border border-line hover:text-ink'
            }`}
          >
            {option.label}
          </Link>
        )
      })}
    </div>
  )
}
