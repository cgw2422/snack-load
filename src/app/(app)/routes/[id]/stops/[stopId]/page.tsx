import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound as nextNotFound } from 'next/navigation'
import { ArrowLeft, Phone, Plus, Receipt } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { getRoute } from '@/server/services/route.service'
import { getCustomer } from '@/server/services/customer.service'
import { formatMoney } from '@/server/domain/money'
import { relativeTime } from '@/lib/dates'
import { isAppError } from '@/lib/errors'
import { Card, CardHeader } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { ButtonLink } from '@/components/ui/Button'
import {
  ArriveForm,
  CompleteStopForm,
  DirectionsLink,
  NoteForm,
} from '@/components/routes/StopWorkflow'
import { addNoteAction } from '@/app/(app)/routes/actions'

export const metadata: Metadata = { title: 'Stop' }

export default async function StopPage(props: PageProps<'/routes/[id]/stops/[stopId]'>) {
  const ctx = await requireAuth()
  const { id, stopId } = await props.params

  let route
  try {
    route = await getRoute(ctx, id)
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') nextNotFound()
    throw error
  }

  const stop = route.stops.find((s) => s.id === stopId)
  if (!stop) nextNotFound()

  const customer = await getCustomer(ctx, stop.customerId)
  const currency = ctx.organization.currency

  const done = stop.status !== 'PENDING' && stop.status !== 'ARRIVED'
  const arrived = stop.status === 'ARRIVED'
  const position = route.stops.findIndex((s) => s.id === stopId) + 1

  // Default a reschedule to a week out — the next time this route runs.
  const nextWeek = new Date()
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <Link
        href={`/routes/${route.id}`}
        className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-navy-600 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {route.name}
      </Link>

      <Card className="p-4">
        <p className="text-[11px] font-bold uppercase tracking-wider text-flame-600">
          Stop {position} of {route.stops.length}
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-ink">{stop.customerName}</h1>
        <p className="mt-0.5 text-sm text-ink-muted">{stop.addressLine}</p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {Number(stop.balance) > 0 ? (
            <Pill tone="alert">Owes {formatMoney(stop.balance, currency)}</Pill>
          ) : (
            <Pill tone="cash">Paid up</Pill>
          )}
          <Pill tone="navy">{customer.paymentTermsCode}</Pill>
          {customer.stats.orderCount > 0 ? (
            <Pill>Usually {formatMoney(customer.stats.averageOrder, currency)}</Pill>
          ) : null}
        </div>

        {stop.phone ? (
          <a
            href={`tel:${stop.phone.replace(/[^\d+]/g, '')}`}
            className="mt-3 inline-flex min-h-touch items-center gap-1.5 rounded-lg text-sm font-semibold text-navy-600 hover:underline"
          >
            <Phone className="size-4" aria-hidden="true" />
            {stop.phone}
          </a>
        ) : null}
      </Card>

      {customer.deliveryInstructions || customer.notes ? (
        <Card className="space-y-2 p-4">
          {customer.deliveryInstructions ? (
            <p className="text-sm text-ink">{customer.deliveryInstructions}</p>
          ) : null}
          {customer.notes ? (
            <p className="text-sm text-ink-muted">{customer.notes}</p>
          ) : null}
        </Card>
      ) : null}

      {done ? (
        <Card className="p-4">
          <p className="text-sm font-semibold text-ink">This stop is finished.</p>
          <p className="text-xs text-ink-muted">
            {stop.status === 'COMPLETED' ? 'Sold' : stop.status.replace(/_/g, ' ').toLowerCase()}
            {stop.outcomeReason ? ` · ${stop.outcomeReason}` : ''}
            {stop.completedAt ? ` · ${relativeTime(new Date(stop.completedAt))}` : ''}
          </p>
          {stop.saleTotal ? (
            <p className="tnum mt-2 text-xl font-extrabold text-cash-600">
              {formatMoney(stop.saleTotal, currency)}
            </p>
          ) : null}
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <DirectionsLink mapQuery={stop.mapQuery} />
            {arrived ? (
              can(ctx, 'sale:create') ? (
                <ButtonLink
                  href={`/sell?customerId=${stop.customerId}&stopId=${stop.id}`}
                  size="lg"
                  variant="accent"
                >
                  <Plus className="size-4" aria-hidden="true" />
                  New sale
                </ButtonLink>
              ) : null
            ) : (
              <ArriveForm stopId={stop.id} routeId={route.id} />
            )}
          </div>

          {arrived ? (
            <CompleteStopForm
              stopId={stop.id}
              routeId={route.id}
              hasSale={Boolean(stop.saleTotal)}
              defaultRescheduleDate={nextWeek.toISOString().slice(0, 10)}
            />
          ) : null}

          <NoteForm stopId={stop.id} routeId={route.id} action={addNoteAction} />
        </>
      )}

      {customer.topProducts.length > 0 ? (
        <Card>
          <CardHeader title="What they usually take" />
          <ul className="divide-y divide-line">
            {customer.topProducts.map((product) => (
              <li key={product.productId} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                  {product.name}
                </span>
                <span className="tnum shrink-0 text-sm text-ink-muted">
                  {product.quantity} {product.uomLabel.toLowerCase()}
                  {product.quantity === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {customer.recentSales.length > 0 ? (
        <Card>
          <CardHeader title="Last few orders" />
          <ul className="divide-y divide-line">
            {customer.recentSales.slice(0, 4).map((sale) => (
              <li key={sale.id} className="flex items-center gap-3 px-4 py-2.5">
                <Receipt className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{sale.saleNumber}</span>
                  <span className="block text-xs text-ink-muted">
                    {relativeTime(new Date(sale.occurredAt))}
                  </span>
                </span>
                <span className="tnum shrink-0 text-sm font-semibold text-ink">
                  {formatMoney(sale.total, currency)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {stop.notes ? (
        <Card className="p-4">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-ink-subtle">
            Notes from this stop
          </h2>
          <p className="mt-1 whitespace-pre-line text-sm text-ink">{stop.notes}</p>
        </Card>
      ) : null}
    </div>
  )
}
