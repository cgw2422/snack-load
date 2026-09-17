import Link from 'next/link'
import { Check, ChevronRight, Send } from 'lucide-react'
import { Card, EmptyState } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { Pagination } from '@/components/ui/Pagination'
import { formatMoney } from '@/server/domain/money'
import { formatShortDate, formatTime } from '@/lib/dates'
import type { SaleListItem } from '@/server/services/sale.service'

/**
 * The receipt book, shared by the global list and one store's history.
 *
 * "Paid" here means the balance is settled, not that a payment was taken at the
 * counter — an invoice closed by a cheque two weeks later reads the same way,
 * because that is the question somebody scanning this list is asking.
 */
export function ReceiptList({
  items,
  total,
  page,
  pageCount,
  sumTotal,
  sumBalanceDue,
  currency,
  timeZone,
  searchParams,
  showCustomer = true,
  emptyTitle,
  emptyDescription,
}: {
  items: SaleListItem[]
  total: number
  page: number
  pageCount: number
  sumTotal: string
  sumBalanceDue: string
  currency: string
  timeZone: string
  searchParams: Record<string, string | undefined>
  showCustomer?: boolean
  emptyTitle: string
  emptyDescription: string
}) {
  const now = new Date()

  return (
    <Card>
      {items.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
              {total} {total === 1 ? 'sale' : 'sales'} matching
            </span>
            <span className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
              <span className="text-ink-muted">
                Billed{' '}
                <span className="tnum font-bold text-ink">{formatMoney(sumTotal, currency)}</span>
              </span>
              {Number(sumBalanceDue) > 0 ? (
                <span className="text-ink-muted">
                  Outstanding{' '}
                  <span className="tnum font-bold text-alert-600">
                    {formatMoney(sumBalanceDue, currency)}
                  </span>
                </span>
              ) : null}
            </span>
          </div>

          <ul className="divide-y divide-line">
            {items.map((sale) => {
              const when = new Date(sale.occurredAt)
              const voided = sale.status === 'VOIDED'
              const owed = Number(sale.balanceDue) > 0 && !voided
              const overdue =
                owed && sale.dueDate ? new Date(sale.dueDate).getTime() < now.getTime() : false

              return (
                <li key={sale.id}>
                  <Link
                    href={`/receipts/${sale.id}`}
                    className="flex min-h-touch items-center gap-2.5 px-4 py-3 transition-colors hover:bg-surface-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-ink">
                          {showCustomer ? sale.customerName : sale.receiptNumber}
                        </span>
                        {voided ? <Pill tone="stop">Voided</Pill> : null}
                        {overdue ? <Pill tone="stop">Overdue</Pill> : null}
                        {sale.delivered ? (
                          <Send className="size-3 shrink-0 text-ink-subtle" aria-label="Sent to the store" />
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        {showCustomer ? `${sale.receiptNumber} · ` : ''}
                        {formatShortDate(when, timeZone)} {formatTime(when, timeZone)}
                      </span>
                      <span className="block truncate text-xs text-ink-subtle">
                        {sale.soldByName}
                      </span>
                    </span>

                    <span className="w-24 shrink-0 text-right">
                      <span
                        className={`tnum block text-sm font-bold ${
                          voided ? 'text-ink-subtle line-through' : 'text-ink'
                        }`}
                      >
                        {formatMoney(sale.total, currency)}
                      </span>
                      {owed ? (
                        <span
                          className={`tnum block text-[11px] font-semibold ${
                            overdue ? 'text-stop-600' : 'text-alert-600'
                          }`}
                        >
                          {formatMoney(sale.balanceDue, currency)} due
                        </span>
                      ) : voided ? (
                        <span className="block text-[11px] font-medium text-ink-subtle">—</span>
                      ) : (
                        <span className="flex items-center justify-end gap-0.5 text-[11px] font-medium text-cash-700">
                          <Check className="size-3" aria-hidden="true" />
                          Paid
                        </span>
                      )}
                    </span>

                    <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <Pagination
        page={page}
        pageCount={pageCount}
        total={total}
        noun="sales"
        searchParams={searchParams}
      />
    </Card>
  )
}
