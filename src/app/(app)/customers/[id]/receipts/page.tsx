import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { listSales } from '@/server/services/sale.service'
import { receiptQuerySchema } from '@/lib/schemas/sales'
import { flattenSearchParams } from '@/lib/searchParams'
import { formatMoney, toAmountString } from '@/server/domain/money'
import { SearchField } from '@/components/ui/SearchField'
import { ReceiptFilters } from '@/components/receipts/ReceiptFilters'
import { ReceiptList } from '@/components/receipts/ReceiptList'

export const metadata: Metadata = { title: 'Receipt history' }

/**
 * One store's complete history (spec §25).
 *
 * The same list and the same filters as the global receipt book, pinned to a
 * customer — so "what have we billed this store since June, and what is still
 * open" is two taps rather than a report request.
 */
export default async function CustomerReceiptsPage(
  props: PageProps<'/customers/[id]/receipts'>,
) {
  const { id } = await props.params
  const ctx = await requireAuth()
  if (!can(ctx, 'sale:read') && !can(ctx, 'sale:read_own')) redirect('/')

  const customer = await db(ctx).customer.findFirst({
    where: { id },
    select: { id: true, name: true, accountNumber: true, balance: true },
  })
  if (!customer) notFound()

  const raw = flattenSearchParams(await props.searchParams)
  const query = receiptQuerySchema.parse({ ...raw, customerId: customer.id })
  const result = await listSales(ctx, query)

  const currency = ctx.organization.currency
  const balance = toAmountString(customer.balance)

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6">
      <Link
        href={`/customers/${customer.id}`}
        className="inline-flex min-h-touch items-center gap-1 text-sm font-semibold text-ink-muted hover:text-ink"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {customer.name}
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-extrabold text-ink">Receipt history</h1>
          <p className="text-sm text-ink-muted">#{customer.accountNumber}</p>
        </div>
        <span
          className={`tnum shrink-0 text-lg font-extrabold ${
            Number(balance) > 0 ? 'text-alert-600' : 'text-cash-700'
          }`}
        >
          {Number(balance) > 0 ? `${formatMoney(balance, currency)} owed` : 'Paid up'}
        </span>
      </div>

      <SearchField placeholder="Search receipt number" />
      <ReceiptFilters />

      <ReceiptList
        {...result}
        currency={currency}
        timeZone={ctx.organization.timezone}
        searchParams={raw}
        showCustomer={false}
        emptyTitle="Nothing matches that"
        emptyDescription={`No sales to ${customer.name} in that range.`}
      />
    </div>
  )
}
