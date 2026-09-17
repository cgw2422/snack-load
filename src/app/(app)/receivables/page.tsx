import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { getReceivables } from '@/server/services/payment.service'
import { getOpenInvoices } from '@/server/services/sale.service'
import { flattenSearchParams, firstValue } from '@/lib/searchParams'
import { formatMoney, toAmountString } from '@/server/domain/money'
import { formatShortDate } from '@/lib/dates'
import { Card, CardHeader, EmptyState } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { PaymentForm } from '@/components/receivables/PaymentForm'

export const metadata: Metadata = { title: 'Receivables' }

/** Aging buckets, measured from the due date (spec §27). */
function daysLate(dueDate: string | null, now: Date): number {
  if (!dueDate) return 0
  return Math.floor((now.getTime() - new Date(dueDate).getTime()) / 86_400_000)
}

function agingTone(days: number): { tone: 'cash' | 'alert' | 'stop'; label: string } {
  if (days <= 0) return { tone: 'cash', label: 'Current' }
  if (days <= 30) return { tone: 'alert', label: `${days}d late` }
  return { tone: 'stop', label: `${days}d late` }
}

export default async function ReceivablesPage(props: PageProps<'/receivables'>) {
  const ctx = await requireAuth()

  const raw = flattenSearchParams(await props.searchParams)
  const customerId = firstValue(raw.customerId)

  // The whole AR book is privileged; a single store's balance is visible to
  // anyone who can collect against it.
  const canSeeAll = can(ctx, 'payment:read')
  if (!canSeeAll && !(customerId && can(ctx, 'payment:create'))) redirect('/')
  const currency = ctx.organization.currency
  const timeZone = ctx.organization.timezone
  const now = new Date()

  // One store: their open invoices and the payment form.
  if (customerId) {
    const [customer, invoices] = await Promise.all([
      db(ctx).customer.findFirst({
        where: { id: customerId },
        select: { id: true, name: true, accountNumber: true, balance: true },
      }),
      getOpenInvoices(ctx, customerId),
    ])
    if (!customer) redirect('/receivables')

    const balance = toAmountString(customer.balance)

    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6">
        {canSeeAll ? (
          <Link
            href="/receivables"
            className="inline-flex min-h-touch items-center gap-1 text-sm font-semibold text-ink-muted hover:text-ink"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            Receivables
          </Link>
        ) : null}

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-extrabold text-ink">{customer.name}</h1>
            <p className="text-sm text-ink-muted">#{customer.accountNumber}</p>
          </div>
          <span
            className={`tnum shrink-0 text-xl font-extrabold ${
              Number(balance) > 0 ? 'text-alert-600' : 'text-cash-700'
            }`}
          >
            {formatMoney(balance, currency)}
          </span>
        </div>

        <Card>
          <CardHeader title="Open invoices" />
          {invoices.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-ink-muted">
              {Number(balance) < 0
                ? 'Nothing open. They are carrying a credit.'
                : 'Nothing open. This account is paid up.'}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {invoices.map((invoice) => {
                const aging = agingTone(daysLate(invoice.dueDate, now))
                return (
                  <li key={invoice.saleId}>
                    <Link
                      href={`/receipts/${invoice.saleId}`}
                      className="flex min-h-touch items-center gap-2.5 px-4 py-3 transition-colors hover:bg-surface-sunken"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">
                          {invoice.saleNumber}
                        </span>
                        <span className="block truncate text-xs text-ink-muted">
                          Due {formatShortDate(new Date(invoice.dueDate), timeZone)} · of{' '}
                          {formatMoney(invoice.total, currency)}
                        </span>
                      </span>
                      <Pill tone={aging.tone}>{aging.label}</Pill>
                      <span className="tnum w-20 shrink-0 text-right text-sm font-bold text-ink">
                        {formatMoney(invoice.balanceDue, currency)}
                      </span>
                      <ChevronRight
                        className="size-4 shrink-0 text-ink-subtle"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {can(ctx, 'payment:create') ? (
          <PaymentForm
            customerId={customer.id}
            balance={Number(balance) > 0 ? balance : '0.00'}
            currency={currency}
          />
        ) : null}
      </div>
    )
  }

  const { rows, total } = await getReceivables(ctx)

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6">
      <div>
        <h1 className="text-xl font-extrabold text-ink">Receivables</h1>
        <p className="text-sm text-ink-muted">What every store owes you.</p>
      </div>

      <Card className="flex items-baseline justify-between gap-3 p-4">
        <span className="text-sm font-semibold text-ink-muted">Total outstanding</span>
        <span className="tnum text-2xl font-extrabold text-ink">
          {formatMoney(total, currency)}
        </span>
      </Card>

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title="Everyone is paid up"
            description="No store is carrying a balance right now."
          />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => {
              const aging = agingTone(daysLate(row.oldestDueDate, now))
              return (
                <li key={row.customerId}>
                  <Link
                    href={`/receivables?customerId=${row.customerId}`}
                    className="flex min-h-touch items-center gap-2.5 px-4 py-3 transition-colors hover:bg-surface-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">
                        {row.name}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        #{row.accountNumber} · {row.invoiceCount}{' '}
                        {row.invoiceCount === 1 ? 'invoice' : 'invoices'}
                      </span>
                    </span>
                    <Pill tone={aging.tone}>{aging.label}</Pill>
                    <span className="tnum w-24 shrink-0 text-right text-sm font-bold text-alert-600">
                      {formatMoney(row.balance, currency)}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
