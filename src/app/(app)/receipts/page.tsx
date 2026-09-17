import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { listSales } from '@/server/services/sale.service'
import { listQuerySchema } from '@/lib/schemas/catalog'
import { flattenSearchParams } from '@/lib/searchParams'
import { formatMoney } from '@/server/domain/money'
import { formatShortDate, formatTime } from '@/lib/dates'
import { Card, EmptyState } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { SearchField } from '@/components/ui/SearchField'
import { Pagination } from '@/components/ui/Pagination'
import { ButtonLink } from '@/components/ui/Button'

export const metadata: Metadata = { title: 'Receipts' }

export default async function ReceiptsPage(props: PageProps<'/receipts'>) {
  const ctx = await requireAuth()
  if (!can(ctx, 'sale:read') && !can(ctx, 'sale:read_own')) redirect('/')

  const raw = flattenSearchParams(await props.searchParams)
  const query = listQuerySchema.parse(raw)
  const { items, total, page, pageCount } = await listSales(ctx, {
    search: query.search,
    page: query.page,
    pageSize: query.pageSize,
  })

  const currency = ctx.organization.currency
  const timeZone = ctx.organization.timezone

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-ink">Receipts</h1>
          <p className="text-sm text-ink-muted">
            {can(ctx, 'sale:read') ? 'Every sale on the books.' : 'Sales you have written.'}
          </p>
        </div>
        {can(ctx, 'sale:create') ? (
          <ButtonLink href="/sell" size="sm" variant="accent">
            New sale
          </ButtonLink>
        ) : null}
      </div>

      <SearchField placeholder="Search receipt number or store" />

      <Card>
        {items.length === 0 ? (
          <EmptyState
            title={query.search ? 'Nothing matches that' : 'No sales yet'}
            description={
              query.search
                ? 'Try a receipt number, store name or account number.'
                : 'Sales you write on the route show up here.'
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((sale) => {
              const when = new Date(sale.occurredAt)
              return (
                <li key={sale.id}>
                  <Link
                    href={`/receipts/${sale.id}`}
                    className="flex min-h-touch items-center gap-2.5 px-4 py-3 transition-colors hover:bg-surface-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-ink">
                          {sale.customerName}
                        </span>
                        {sale.status === 'VOIDED' ? <Pill tone="stop">Voided</Pill> : null}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        {sale.saleNumber} · {formatShortDate(when, timeZone)}{' '}
                        {formatTime(when, timeZone)}
                      </span>
                      <span className="block truncate text-xs text-ink-subtle">
                        {sale.soldByName}
                      </span>
                    </span>

                    <span className="w-24 shrink-0 text-right">
                      <span
                        className={`tnum block text-sm font-bold ${
                          sale.status === 'VOIDED' ? 'text-ink-subtle line-through' : 'text-ink'
                        }`}
                      >
                        {formatMoney(sale.total, currency)}
                      </span>
                      {Number(sale.balanceDue) > 0 && sale.status !== 'VOIDED' ? (
                        <span className="tnum block text-[11px] font-semibold text-alert-600">
                          {formatMoney(sale.balanceDue, currency)} due
                        </span>
                      ) : (
                        <span className="block text-[11px] font-medium text-ink-subtle">Paid</span>
                      )}
                    </span>

                    <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}

        <Pagination
          page={page}
          pageCount={pageCount}
          total={total}
          noun="sales"
          searchParams={raw}
        />
      </Card>
    </div>
  )
}
