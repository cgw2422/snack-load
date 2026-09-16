import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound as nextNotFound } from 'next/navigation'
import { ArrowLeft, Clock, MapPin, Play, Route as RouteIcon, Truck } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { getRoute } from '@/server/services/route.service'
import { formatMoney } from '@/server/domain/money'
import { dateOnly, formatShortDate } from '@/lib/dates'
import { isAppError } from '@/lib/errors'
import { Card, CardHeader } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { Button, ButtonLink } from '@/components/ui/Button'
import { RouteMap } from '@/components/routes/RouteMap'
import { StopList } from '@/components/routes/StopList'
import { OptimizeButton, ReassignPanel } from '@/components/routes/RouteActions'
import { startRouteAction } from '../actions'

export const metadata: Metadata = { title: 'Route' }

const STATUS: Record<string, { label: string; tone: 'navy' | 'flame' | 'cash' | 'neutral' }> = {
  PLANNED: { label: 'Planned', tone: 'navy' },
  IN_PROGRESS: { label: 'Running', tone: 'flame' },
  COMPLETED: { label: 'Done', tone: 'cash' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
}

export default async function RoutePage(props: PageProps<'/routes/[id]'>) {
  const ctx = await requireAuth()
  const { id } = await props.params

  let route
  try {
    route = await getRoute(ctx, id)
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') nextNotFound()
    throw error
  }

  const prisma = db(ctx)
  const [warehouse, members] = await Promise.all([
    prisma.warehouse.findFirst({
      where: { isPrimary: true },
      select: { latitude: true, longitude: true, location: { select: { name: true } } },
    }),
    can(ctx, 'route:assign')
      ? prisma.membership.findMany({
          where: { status: 'ACTIVE' },
          select: { user: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { joinedAt: 'asc' },
        })
      : [],
  ])

  const currency = ctx.organization.currency
  const timezone = ctx.organization.timezone
  const isMine = route.runnerId === ctx.userId
  const completed = route.stops.filter((s) => s.status !== 'PENDING' && s.status !== 'ARRIVED')
  const pending = route.stops.filter((s) => s.status === 'PENDING' || s.status === 'ARRIVED')
  const nextStop = pending[0]

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <Link
        href="/routes"
        className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-navy-600 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Routes
      </Link>

      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold text-ink">{route.name}</h1>
            <p className="mt-0.5 text-sm text-ink-muted">
              {formatShortDate(dateOnly(route.serviceDate), 'UTC')} · {route.runnerName}
              {route.vehicleName ? ` · ${route.vehicleName}` : ''}
            </p>
          </div>
          <Pill tone={STATUS[route.status]?.tone ?? 'navy'}>
            {STATUS[route.status]?.label ?? route.status}
          </Pill>
        </div>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-ink-muted">
          <span className="flex items-center gap-1.5">
            <RouteIcon className="size-3.5" aria-hidden="true" />
            {completed.length}/{route.stops.length} stops
          </span>
          {route.plannedMiles ? (
            <span className="flex items-center gap-1.5">
              <MapPin className="size-3.5" aria-hidden="true" />
              {route.plannedMiles} mi
            </span>
          ) : null}
          {route.plannedMinutes ? (
            <span className="flex items-center gap-1.5">
              <Clock className="size-3.5" aria-hidden="true" />
              about {Math.floor(route.plannedMinutes / 60)}h {route.plannedMinutes % 60}m
            </span>
          ) : null}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-card bg-cash-50 px-3.5 py-3 text-cash-700 dark:bg-cash-700/20 dark:text-cash-100">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">Sold</p>
          <p className="tnum mt-1 text-2xl font-extrabold">
            {formatMoney(route.salesTotal, currency)}
          </p>
        </div>
        <div className="rounded-card bg-navy-50 px-3.5 py-3 text-navy-800 dark:bg-navy-900/60 dark:text-navy-100">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">Collected</p>
          <p className="tnum mt-1 text-2xl font-extrabold">
            {formatMoney(route.collectedTotal, currency)}
          </p>
        </div>
      </div>

      {isMine && route.status === 'PLANNED' && can(ctx, 'routerun:start') ? (
        <form action={startRouteAction}>
          <input type="hidden" name="routeId" value={route.id} />
          <Button type="submit" variant="accent" size="lg" block>
            <Play className="size-4" aria-hidden="true" />
            Start route
          </Button>
        </form>
      ) : null}

      {isMine && nextStop && route.status === 'IN_PROGRESS' ? (
        <ButtonLink href={`/routes/${route.id}/stops/${nextStop.id}`} size="lg" variant="accent" block>
          Next stop · {nextStop.customerName}
        </ButtonLink>
      ) : null}

      <RouteMap
        stops={route.stops.map((stop) => ({
          id: stop.id,
          sequence: stop.sequence,
          customerName: stop.customerName,
          latitude: stop.latitude,
          longitude: stop.longitude,
          status: stop.status,
        }))}
        start={
          warehouse?.latitude && warehouse.longitude
            ? {
                latitude: Number(warehouse.latitude),
                longitude: Number(warehouse.longitude),
                name: warehouse.location.name,
              }
            : null
        }
        className="aspect-[4/3] sm:aspect-[16/10]"
      />

      <Card>
        <CardHeader title="Stops" />
        <StopList
          routeId={route.id}
          stops={route.stops}
          currency={currency}
          timezone={timezone}
          interactive={isMine || can(ctx, 'route:read')}
        />
      </Card>

      {can(ctx, 'route:optimize') && route.status === 'PLANNED' && pending.length > 1 ? (
        <OptimizeButton routeId={route.id} />
      ) : null}

      {can(ctx, 'route:assign') && route.status !== 'COMPLETED' ? (
        <ReassignPanel
          routeId={route.id}
          runners={members
            .filter((mm) => mm.user.id !== route.runnerId)
            .map((mm) => ({
              id: mm.user.id,
              name: `${mm.user.firstName} ${mm.user.lastName}`.trim(),
            }))}
          pendingStops={pending.map((stop) => ({
            id: stop.id,
            sequence: stop.sequence,
            customerName: stop.customerName,
          }))}
        />
      ) : null}

      {route.vehicleName && can(ctx, 'inventory:load_truck') && route.status === 'PLANNED' ? (
        <ButtonLink href="/inventory/load" size="md" variant="secondary" block>
          <Truck className="size-4" aria-hidden="true" />
          Load {route.vehicleName}
        </ButtonLink>
      ) : null}
    </div>
  )
}
