import Link from 'next/link'
import { ChevronRight, Navigation, TriangleAlert } from 'lucide-react'
import { requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import {
  dashboardKindFor,
  getOperatorDashboard,
  getRunnerDashboard,
} from '@/server/services/dashboard.service'
import { formatMoney } from '@/server/domain/money'
import { formatQuantity } from '@/server/domain/uom'
import { relativeTime } from '@/lib/dates'
import { Card, CardHeader, EmptyState } from '@/components/ui/Card'
import { ButtonLink } from '@/components/ui/Button'
import { MetricTileCard } from '@/components/dashboard/MetricTile'
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist'

export default async function DashboardPage() {
  const ctx = await requireAuth()

  const organization = await db(ctx).organization.findFirst({
    where: { id: ctx.organizationId },
    select: { onboardingJson: true },
  })
  const onboarding = (organization?.onboardingJson ?? {}) as Record<string, boolean>

  return dashboardKindFor(ctx) === 'runner' ? (
    <RunnerHome ctx={ctx} />
  ) : (
    <OperatorHome ctx={ctx} onboarding={onboarding} />
  )
}

type Ctx = Awaited<ReturnType<typeof requireAuth>>

async function OperatorHome({
  ctx,
  onboarding,
}: {
  ctx: Ctx
  onboarding: Record<string, boolean>
}) {
  const data = await getOperatorDashboard(ctx)
  const currency = ctx.organization.currency

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <OnboardingChecklist state={onboarding} />

      <section aria-label="Today at a glance">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
          {data.metrics.map((metric) => (
            <MetricTileCard key={metric.key} metric={metric} currency={currency} />
          ))}
        </div>
      </section>

      <Card>
        <CardHeader
          title="Today's routes"
          action={
            <Link href="/routes" className="text-sm font-semibold text-navy-600 hover:underline">
              Plan
            </Link>
          }
        />
        {data.routes.length === 0 ? (
          <EmptyState
            title="No routes scheduled today"
            description="Build a route from the accounts that are due."
            action={
              <ButtonLink href="/routes" size="sm" variant="secondary">
                Open route planner
              </ButtonLink>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.routes.map((route) => (
              <li key={route.id}>
                <Link
                  href={`/routes/${route.id}`}
                  className="flex min-h-touch items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">
                      {route.runnerName} · {route.name}
                    </span>
                    <span className="block truncate text-xs text-ink-muted">
                      {route.completedStops}/{route.totalStops} stops
                      {route.vehicleName ? ` · ${route.vehicleName}` : ''}
                    </span>
                  </span>
                  <span className="tnum text-sm font-bold text-cash-600">
                    {formatMoney(route.salesTotal, currency)}
                  </span>
                  <RouteStatusPill status={route.status} />
                  <ChevronRight className="size-4 text-ink-subtle" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Low stock"
            action={
              <Link
                href="/inventory"
                className="text-sm font-semibold text-navy-600 hover:underline"
              >
                View all
              </Link>
            }
          />
          {data.lowStock.length === 0 ? (
            <EmptyState
              title="Nothing running low"
              description="Products below their reorder point will show up here."
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.lowStock.map((item) => (
                <li
                  key={item.productId}
                  className="flex min-h-touch items-center gap-3 px-4 py-2.5"
                >
                  <TriangleAlert
                    className="size-4 shrink-0 text-alert-500"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">
                      {item.name}
                    </span>
                    <span className="block text-xs text-ink-muted">SKU {item.sku}</span>
                  </span>
                  <span className="tnum shrink-0 text-sm font-bold text-alert-600">
                    {formatQuantity(item.quantity, item.baseUnitsPerCase)} left
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          {data.activity.length === 0 ? (
            <EmptyState title="Nothing yet" description="Activity will appear as your team works." />
          ) : (
            <ul className="divide-y divide-line">
              {data.activity.map((entry) => (
                <li key={entry.id} className="flex items-start gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{entry.summary}</span>
                    <span className="block text-xs text-ink-muted">
                      {entry.actorName ? `${entry.actorName} · ` : ''}
                      {relativeTime(new Date(entry.at))}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

async function RunnerHome({ ctx }: { ctx: Ctx }) {
  const data = await getRunnerDashboard(ctx)
  const currency = ctx.organization.currency

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4">
      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-card bg-cash-50 px-3.5 py-3 text-cash-700 dark:bg-cash-700/20 dark:text-cash-100">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">Sold today</p>
          <p className="tnum mt-1 text-2xl font-extrabold">
            {formatMoney(data.salesToday, currency)}
          </p>
        </div>
        <div className="rounded-card bg-navy-50 px-3.5 py-3 text-navy-800 dark:bg-navy-900/60 dark:text-navy-100">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">Stops</p>
          <p className="tnum mt-1 text-2xl font-extrabold">
            {data.completedStops} / {data.totalStops}
          </p>
        </div>
      </div>

      {data.nextStop ? (
        <Card className="overflow-hidden">
          <div className="border-b border-line px-4 pt-4 pb-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-flame-600">
              Next stop
            </p>
            <h2 className="mt-1 text-xl font-extrabold text-ink">{data.nextStop.customerName}</h2>
            <p className="mt-0.5 text-sm text-ink-muted">{data.nextStop.address}</p>
            {Number(data.nextStop.balance) > 0 ? (
              <p className="tnum mt-2 text-sm font-semibold text-alert-600">
                Owes {formatMoney(data.nextStop.balance, currency)}
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-2.5 p-4">
            <ButtonLink
              href={`/customers/${data.nextStop.customerId}`}
              size="lg"
              variant="secondary"
            >
              <Navigation className="size-4" aria-hidden="true" />
              Directions
            </ButtonLink>
            <ButtonLink
              href={`/routes/${data.routeId}/stops/${data.nextStop.stopId}`}
              size="lg"
              variant="accent"
            >
              Start stop
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <Card>
          <EmptyState
            title={data.routeId ? 'Route complete' : 'No route today'}
            description={
              data.routeId
                ? 'Every stop is done. Close out when you are back.'
                : 'Nothing is assigned to you for today.'
            }
          />
        </Card>
      )}

      {data.remaining.length > 0 ? (
        <Card>
          <CardHeader title="Coming up" />
          <ul className="divide-y divide-line">
            {data.remaining.map((stop) => (
              <li key={stop.stopId} className="flex min-h-touch items-center gap-3 px-4 py-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-navy-100 text-xs font-bold text-navy-800">
                  {stop.sequence}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {stop.customerName}
                  </span>
                  <span className="block truncate text-xs text-ink-muted">{stop.address}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}

function RouteStatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    PLANNED: 'bg-navy-100 text-navy-700',
    IN_PROGRESS: 'bg-flame-100 text-flame-700',
    COMPLETED: 'bg-cash-100 text-cash-700',
    CANCELLED: 'bg-surface-sunken text-ink-subtle',
  }
  const labels: Record<string, string> = {
    PLANNED: 'Planned',
    IN_PROGRESS: 'Running',
    COMPLETED: 'Done',
    CANCELLED: 'Cancelled',
  }
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${styles[status] ?? styles.PLANNED}`}
    >
      {labels[status] ?? status}
    </span>
  )
}
