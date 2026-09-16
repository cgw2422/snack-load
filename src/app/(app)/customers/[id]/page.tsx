import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound as nextNotFound } from 'next/navigation'
import {
  ArrowLeft, CalendarClock, ChevronRight, CreditCard, Mail, Navigation, Phone, Plus, Repeat,
} from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { getCustomer } from '@/server/services/customer.service'
import { formatMoney } from '@/server/domain/money'
import { relativeTime } from '@/lib/dates'
import { isAppError } from '@/lib/errors'
import { Card, CardHeader } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { ButtonLink } from '@/components/ui/Button'

export const metadata: Metadata = { title: 'Customer' }

const DAY_LABEL: Record<string, string> = {
  MONDAY: 'Mondays', TUESDAY: 'Tuesdays', WEDNESDAY: 'Wednesdays', THURSDAY: 'Thursdays',
  FRIDAY: 'Fridays', SATURDAY: 'Saturdays', SUNDAY: 'Sundays',
}
const FREQUENCY_LABEL: Record<string, string> = {
  WEEKLY: 'weekly', BIWEEKLY: 'every two weeks', TRIWEEKLY: 'every three weeks',
  MONTHLY: 'monthly', CUSTOM: 'on a custom cycle',
}

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth()
  const { id } = await params

  let customer
  try {
    customer = await getCustomer(ctx, id)
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') nextNotFound()
    throw error
  }

  const currency = ctx.organization.currency
  const owes = Number(customer.stats.openBalance) > 0

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <Link
        href="/customers"
        className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-navy-600 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Customers
      </Link>

      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold text-ink">{customer.name}</h1>
            <p className="mt-0.5 text-sm text-ink-muted">
              #{customer.accountNumber}
              {customer.parentCompany ? ` · ${customer.parentCompany}` : ''}
            </p>
            {customer.addressLine ? (
              <p className="text-sm text-ink-muted">{customer.addressLine}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {!customer.active ? <Pill>Inactive</Pill> : null}
            <Pill tone="navy">{customer.paymentTermsCode}</Pill>
            {customer.taxExempt ? <Pill tone="cash">Tax exempt</Pill> : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          {customer.phone ? (
            <a
              href={`tel:${customer.phone.replace(/[^\d+]/g, '')}`}
              className="inline-flex min-h-touch items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-navy-600 hover:bg-surface-sunken"
            >
              <Phone className="size-4" aria-hidden="true" />
              {customer.phone}
            </a>
          ) : null}
          {customer.email ? (
            <a
              href={`mailto:${customer.email}`}
              className="inline-flex min-h-touch items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-navy-600 hover:bg-surface-sunken"
            >
              <Mail className="size-4" aria-hidden="true" />
              {customer.email}
            </a>
          ) : null}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2.5">
        <div
          className={`rounded-card px-3.5 py-3 ${
            owes
              ? 'bg-amber-50 text-alert-600 dark:bg-alert-600/20 dark:text-amber-100'
              : 'bg-cash-50 text-cash-700 dark:bg-cash-700/20 dark:text-cash-100'
          }`}
        >
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">Owes</p>
          <p className="tnum mt-1 text-2xl font-extrabold">
            {formatMoney(customer.stats.openBalance, currency)}
          </p>
          {customer.creditLimit ? (
            <p className="mt-0.5 text-[11px] font-medium opacity-70">
              Limit {formatMoney(customer.creditLimit, currency)}
            </p>
          ) : null}
        </div>

        <div className="rounded-card bg-navy-50 px-3.5 py-3 text-navy-800 dark:bg-navy-900/60 dark:text-navy-100">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">Average order</p>
          <p className="tnum mt-1 text-2xl font-extrabold">
            {formatMoney(customer.stats.averageOrder, currency)}
          </p>
          <p className="mt-0.5 text-[11px] font-medium opacity-70">
            {customer.stats.orderCount} {customer.stats.orderCount === 1 ? 'order' : 'orders'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {can(ctx, 'sale:create') ? (
          <ButtonLink href={`/sell?customerId=${customer.id}`} size="lg" variant="accent">
            <Plus className="size-4" aria-hidden="true" />
            New sale
          </ButtonLink>
        ) : null}
        {can(ctx, 'payment:create') ? (
          <ButtonLink href={`/receivables?customerId=${customer.id}`} size="lg" variant="cash">
            <CreditCard className="size-4" aria-hidden="true" />
            Payment
          </ButtonLink>
        ) : null}
        <ButtonLink
          href={`https://maps.google.com/?q=${encodeURIComponent(customer.mapQuery)}`}
          target="_blank"
          rel="noopener noreferrer"
          size="lg"
          variant="secondary"
        >
          <Navigation className="size-4" aria-hidden="true" />
          Navigate
        </ButtonLink>
        {customer.recentSales[0] && can(ctx, 'sale:create') ? (
          <ButtonLink
            href={`/sell?customerId=${customer.id}&repeat=${customer.recentSales[0].id}`}
            size="lg"
            variant="secondary"
          >
            <Repeat className="size-4" aria-hidden="true" />
            Repeat
          </ButtonLink>
        ) : null}
      </div>

      {customer.schedule ? (
        <Card className="flex items-center gap-3 p-4">
          <CalendarClock className="size-5 shrink-0 text-navy-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">
              {customer.schedule.routeName} · {DAY_LABEL[customer.schedule.dayOfWeek] ?? customer.schedule.dayOfWeek}
            </p>
            <p className="text-xs text-ink-muted">
              Serviced {FREQUENCY_LABEL[customer.schedule.frequency] ?? ''}
              {customer.lastVisitAt
                ? ` · last visit ${relativeTime(new Date(customer.lastVisitAt))}`
                : ' · not visited yet'}
            </p>
          </div>
        </Card>
      ) : (
        <Card className="p-4">
          <p className="text-sm font-semibold text-ink">No route assigned</p>
          <p className="text-xs text-ink-muted">
            This store will not appear on anyone&apos;s route until it is scheduled.
          </p>
        </Card>
      )}

      {customer.deliveryInstructions || customer.notes ? (
        <Card className="space-y-3 p-4">
          {customer.deliveryInstructions ? (
            <div>
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-ink-subtle">
                Delivery instructions
              </h2>
              <p className="mt-1 whitespace-pre-line text-sm text-ink">
                {customer.deliveryInstructions}
              </p>
            </div>
          ) : null}
          {customer.notes ? (
            <div>
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-ink-subtle">
                Notes
              </h2>
              <p className="mt-1 whitespace-pre-line text-sm text-ink">{customer.notes}</p>
            </div>
          ) : null}
        </Card>
      ) : null}

      {customer.topProducts.length > 0 ? (
        <Card>
          <CardHeader title="What they buy" />
          <ul className="divide-y divide-line">
            {customer.topProducts.map((product) => (
              <li key={product.productId} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {product.name}
                  </span>
                  <span className="block text-xs text-ink-muted">SKU {product.sku}</span>
                </span>
                <span className="tnum shrink-0 text-sm font-semibold text-ink-muted">
                  {product.quantity} {product.uomLabel.toLowerCase()}
                  {product.quantity === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Recent orders" />
        {customer.recentSales.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-ink-muted">No orders yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {customer.recentSales.map((sale) => (
              <li key={sale.id}>
                <Link
                  href={`/receipts/${sale.id}`}
                  className="flex min-h-touch items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-sunken"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink">{sale.saleNumber}</span>
                    <span className="block text-xs text-ink-muted">
                      {relativeTime(new Date(sale.occurredAt))}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tnum block text-sm font-bold text-ink">
                      {formatMoney(sale.total, currency)}
                    </span>
                    {Number(sale.balanceDue) > 0 ? (
                      <span className="tnum block text-xs font-semibold text-alert-600">
                        {formatMoney(sale.balanceDue, currency)} due
                      </span>
                    ) : (
                      <span className="block text-xs font-medium text-cash-600">Paid</span>
                    )}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
