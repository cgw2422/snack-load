import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { listCustomers } from '@/server/services/customer.service'
import { getRepeatLines, resolveSellingLocation } from '@/server/services/sale.service'
import { listQuerySchema } from '@/lib/schemas/catalog'
import { flattenSearchParams, firstValue } from '@/lib/searchParams'
import { toAmountString } from '@/server/domain/money'
import { Card, EmptyState } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { SearchField } from '@/components/ui/SearchField'
import { SellScreen } from '@/components/sell/SellScreen'

export const metadata: Metadata = { title: 'New sale' }

export default async function SellPage(props: PageProps<'/sell'>) {
  const ctx = await requireAuth()
  if (!can(ctx, 'sale:create')) redirect('/')

  const raw = flattenSearchParams(await props.searchParams)
  const customerId = firstValue(raw.customerId)
  const currency = ctx.organization.currency

  // No store chosen yet: pick one. This is the path a runner takes when they
  // open "New sale" from the tab bar rather than from a route stop.
  if (!customerId) {
    const query = listQuerySchema.parse({ ...raw, status: 'active' })
    const { items } = await listCustomers(ctx, query)

    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6">
        <div>
          <h1 className="text-xl font-extrabold text-ink">New sale</h1>
          <p className="text-sm text-ink-muted">Which store are you selling to?</p>
        </div>

        <SearchField placeholder="Search store, account number or city" />

        <Card>
          {items.length === 0 ? (
            <EmptyState
              title={query.search ? 'Nothing matches that' : 'No active stores'}
              description={
                query.search
                  ? 'Try a different name, account number or city.'
                  : 'Add or import your accounts before selling.'
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {items.map((customer) => (
                <li key={customer.id}>
                  <Link
                    href={`/sell?customerId=${customer.id}`}
                    className="flex min-h-touch items-center gap-2.5 px-4 py-3 transition-colors hover:bg-surface-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">
                        {customer.name}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        #{customer.accountNumber}
                        {customer.addressLine ? ` · ${customer.addressLine}` : ''}
                      </span>
                    </span>
                    {Number(customer.balance) > 0 ? (
                      <Pill tone="alert">Owes</Pill>
                    ) : null}
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

  const customer = await db(ctx).customer.findFirst({
    where: { id: customerId },
    select: {
      id: true, name: true, balance: true, paymentTermsCode: true, active: true,
      taxExempt: true,
      taxRate: { select: { rate: true } },
    },
  })
  if (!customer || !customer.active) redirect('/sell')

  const repeatId = firstValue(raw.repeat)
  // Resolved here, not after the first re-price, so the very first product
  // search already counts what is on this runner's truck.
  const [sellingLocation, initialLines] = await Promise.all([
    resolveSellingLocation(ctx),
    repeatId ? getRepeatLines(ctx, repeatId) : undefined,
  ])

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-4 pb-nav md:px-6 md:py-6">
      <SellScreen
        customer={{
          id: customer.id,
          name: customer.name,
          balance: toAmountString(customer.balance),
          termsCode: customer.paymentTermsCode,
          // Sent so the screen can still show a total when the server cannot
          // be reached. It is an estimate and is labelled as one; the posted
          // sale is priced server-side on arrival (docs/05 §3).
          taxExempt: customer.taxExempt,
          taxRate: customer.taxRate?.rate.toString() ?? '0',
        }}
        routeStopId={firstValue(raw.stopId)}
        currency={currency}
        sellingLocation={sellingLocation}
        initialLines={initialLines}
      />
    </div>
  )
}
