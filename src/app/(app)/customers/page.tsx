import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ChevronRight, Upload } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { listCustomers } from '@/server/services/customer.service'
import { listQuerySchema } from '@/lib/schemas/catalog'
import { flattenSearchParams } from '@/lib/searchParams'
import { formatMoney } from '@/server/domain/money'
import { relativeTime } from '@/lib/dates'
import { Card, EmptyState } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { SearchField } from '@/components/ui/SearchField'
import { Pagination } from '@/components/ui/Pagination'
import { ButtonLink } from '@/components/ui/Button'
import { BulkActionBar } from '@/components/customers/BulkActionBar'
import { db } from '@/server/db/tenant'

export const metadata: Metadata = { title: 'Customers' }

const DAY_LABEL: Record<string, string> = {
  MONDAY: 'Mon', TUESDAY: 'Tue', WEDNESDAY: 'Wed', THURSDAY: 'Thu',
  FRIDAY: 'Fri', SATURDAY: 'Sat', SUNDAY: 'Sun',
}

export default async function CustomersPage(props: PageProps<'/customers'>) {
  const ctx = await requireAuth()
  if (!can(ctx, 'customer:read')) redirect('/')

  const raw = flattenSearchParams(await props.searchParams)
  const query = listQuerySchema.parse(raw)
  const { items, total, page, pageCount } = await listCustomers(ctx, query)
  const currency = ctx.organization.currency
  const canBulkEdit = can(ctx, 'customer:update')

  const [routes, priceGroups] = canBulkEdit
    ? await Promise.all([
        db(ctx).routeTemplate.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            defaultRunner: { select: { id: true, firstName: true, lastName: true } },
          },
        }),
        db(ctx).priceGroup.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
      ])
    : [[], []]

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-ink">Customers</h1>
          <p className="text-sm text-ink-muted">
            Gas stations, convenience stores and markets you service.
          </p>
        </div>
        {can(ctx, 'customer:import') ? (
          <ButtonLink href="/customers/import" size="sm" variant="secondary">
            <Upload className="size-4" aria-hidden="true" />
            Import
          </ButtonLink>
        ) : null}
      </div>

      <SearchField placeholder="Search store, account number or city" />

      <BulkActionBar
        canEdit={canBulkEdit}
        routes={routes.map((r) => ({
          id: r.id,
          name: r.name,
          runnerId: r.defaultRunner?.id ?? null,
          runnerName: r.defaultRunner
            ? `${r.defaultRunner.firstName} ${r.defaultRunner.lastName}`.trim()
            : null,
        }))}
        priceGroups={priceGroups}
      >
        <Card>
          {items.length === 0 ? (
            <EmptyState
              title={query.search ? 'Nothing matches that' : 'No stores yet'}
              description={
                query.search
                  ? 'Try a different name, account number or city.'
                  : 'Import your accounts from a spreadsheet to get started.'
              }
              action={
                can(ctx, 'customer:import') && !query.search ? (
                  <ButtonLink href="/customers/import" size="sm" variant="secondary">
                    Import stores
                  </ButtonLink>
                ) : null
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {items.map((customer) => (
                <li key={customer.id} className="flex items-center">
                  {canBulkEdit ? (
                    <label className="flex size-touch shrink-0 cursor-pointer items-center justify-center pl-2">
                      <span className="sr-only">Select {customer.name}</span>
                      <input
                        type="checkbox"
                        name="customerIds"
                        value={customer.id}
                        className="size-5 rounded border-line-strong text-navy-700 focus:ring-navy-500/30"
                      />
                    </label>
                  ) : null}

                  <Link
                    href={`/customers/${customer.id}`}
                    className="flex min-h-touch min-w-0 flex-1 items-center gap-2.5 px-3 py-3 transition-colors hover:bg-surface-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-ink">
                          {customer.name}
                        </span>
                        {!customer.active ? <Pill>Inactive</Pill> : null}
                        {customer.overCreditLimit ? <Pill tone="stop">Over limit</Pill> : null}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        #{customer.accountNumber}
                        {customer.addressLine ? ` · ${customer.addressLine}` : ''}
                      </span>
                      <span className="block truncate text-xs text-ink-subtle">
                        {customer.routeName
                          ? `${customer.routeName}${customer.visitDay ? ` · ${DAY_LABEL[customer.visitDay] ?? customer.visitDay}` : ''}${customer.runnerName ? ` · ${customer.runnerName}` : ''}`
                          : 'No route assigned'}
                        {customer.lastVisitAt
                          ? ` · visited ${relativeTime(new Date(customer.lastVisitAt))}`
                          : ''}
                      </span>
                    </span>

                    <span className="w-24 shrink-0 text-right">
                      <span
                        className={`tnum block text-sm font-bold ${
                          Number(customer.balance) > 0 ? 'text-alert-600' : 'text-ink-subtle'
                        }`}
                      >
                        {Number(customer.balance) > 0
                          ? formatMoney(customer.balance, currency)
                          : '—'}
                      </span>
                      <span className="block text-[11px] font-medium text-ink-subtle">
                        {customer.paymentTermsCode}
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
            noun="stores"
            searchParams={raw}
          />
        </Card>
      </BulkActionBar>
    </div>
  )
}
