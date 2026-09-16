import Link from 'next/link'
import type { Metadata } from 'next'
import { CalendarDays, ChevronRight, Plus } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { listRoutes } from '@/server/services/route.service'
import { formatMoney } from '@/server/domain/money'
import { dateOnly, formatShortDate, todayDateOnly } from '@/lib/dates'
import { Card, EmptyState } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { ButtonLink } from '@/components/ui/Button'

export const metadata: Metadata = { title: 'Routes' }

const STATUS: Record<string, { label: string; tone: 'navy' | 'flame' | 'cash' | 'neutral' }> = {
  PLANNED: { label: 'Planned', tone: 'navy' },
  IN_PROGRESS: { label: 'Running', tone: 'flame' },
  COMPLETED: { label: 'Done', tone: 'cash' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
}

export default async function RoutesPage() {
  const ctx = await requireAuth()
  const routes = await listRoutes(ctx)
  const currency = ctx.organization.currency
  const timezone = ctx.organization.timezone
  const today = todayDateOnly(timezone).toISOString().slice(0, 10)

  const grouped = new Map<string, typeof routes>()
  for (const route of routes) {
    if (!grouped.has(route.serviceDate)) grouped.set(route.serviceDate, [])
    grouped.get(route.serviceDate)!.push(route)
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-ink">Routes</h1>
          <p className="text-sm text-ink-muted">
            {can(ctx, 'route:read') ? 'Every run, by day.' : 'Your runs.'}
          </p>
        </div>
        {can(ctx, 'route:create') ? (
          <ButtonLink href="/routes/plan" size="sm" variant="accent">
            <Plus className="size-4" aria-hidden="true" />
            Plan
          </ButtonLink>
        ) : null}
      </div>

      {grouped.size === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarDays className="size-8" aria-hidden="true" />}
            title="No routes yet"
            description={
              can(ctx, 'route:create')
                ? 'Build a route from the accounts that are due.'
                : 'Nothing has been assigned to you.'
            }
            action={
              can(ctx, 'route:create') ? (
                <ButtonLink href="/routes/plan" size="sm" variant="secondary">
                  Open the planner
                </ButtonLink>
              ) : null
            }
          />
        </Card>
      ) : (
        [...grouped.entries()].map(([date, dayRoutes]) => (
          <Card key={date}>
            <div className="flex items-baseline justify-between border-b border-line px-4 py-2.5">
              <h2 className="text-[15px] font-semibold text-ink">
                {formatShortDate(dateOnly(date), 'UTC')}
              </h2>
              {date === today ? <Pill tone="flame">Today</Pill> : null}
            </div>

            <ul className="divide-y divide-line">
              {dayRoutes.map((route) => (
                <li key={route.id}>
                  <Link
                    href={`/routes/${route.id}`}
                    className="flex min-h-touch items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">
                        {route.name} · {route.runnerName}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        {route.completedStops}/{route.totalStops} stops
                        {route.vehicleName ? ` · ${route.vehicleName}` : ''}
                      </span>
                    </span>
                    {Number(route.salesTotal) > 0 ? (
                      <span className="tnum shrink-0 text-sm font-bold text-cash-600">
                        {formatMoney(route.salesTotal, currency)}
                      </span>
                    ) : null}
                    <Pill tone={STATUS[route.status]?.tone ?? 'navy'}>
                      {STATUS[route.status]?.label ?? route.status}
                    </Pill>
                    <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  )
}
