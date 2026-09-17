import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { can, requireAuth } from '@/server/auth/context'
import { listSales } from '@/server/services/sale.service'
import { receiptQuerySchema } from '@/lib/schemas/sales'
import { flattenSearchParams } from '@/lib/searchParams'
import { SearchField } from '@/components/ui/SearchField'
import { ButtonLink } from '@/components/ui/Button'
import { ReceiptFilters } from '@/components/receipts/ReceiptFilters'
import { ReceiptList } from '@/components/receipts/ReceiptList'

export const metadata: Metadata = { title: 'Receipts' }

export default async function ReceiptsPage(props: PageProps<'/receipts'>) {
  const ctx = await requireAuth()
  if (!can(ctx, 'sale:read') && !can(ctx, 'sale:read_own')) redirect('/')

  const raw = flattenSearchParams(await props.searchParams)
  const query = receiptQuerySchema.parse(raw)
  const result = await listSales(ctx, query)

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
      <ReceiptFilters />

      <ReceiptList
        {...result}
        currency={ctx.organization.currency}
        timeZone={ctx.organization.timezone}
        searchParams={raw}
        emptyTitle={hasFilters(raw) ? 'Nothing matches that' : 'No sales yet'}
        emptyDescription={
          hasFilters(raw)
            ? 'Try a wider date range, a different amount, or clear the filters.'
            : 'Sales you write on the route show up here.'
        }
      />
    </div>
  )
}

function hasFilters(raw: Record<string, string | undefined>): boolean {
  return ['search', 'from', 'to', 'minAmount', 'maxAmount'].some((key) => Boolean(raw[key])) ||
    (raw.status !== undefined && raw.status !== 'all')
}
