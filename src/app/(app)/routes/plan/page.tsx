import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { getAccountsDue, listRouteTemplates } from '@/server/services/route.service'
import { listVehicles } from '@/server/services/truckload.service'
import { localDateString } from '@/lib/dates'
import { firstValue } from '@/lib/searchParams'
import { Card, EmptyState } from '@/components/ui/Card'
import { PlannerFilters } from '@/components/routes/PlannerFilters'
import { RoutePlanner } from '@/components/routes/RoutePlanner'

export const metadata: Metadata = { title: 'Plan a route' }

export default async function PlanPage(props: PageProps<'/routes/plan'>) {
  const ctx = await requireAuth()
  if (!can(ctx, 'route:create')) redirect('/routes')

  const params = await props.searchParams
  const templates = await listRouteTemplates(ctx)
  const active = templates.filter((t) => t.active)

  if (active.length === 0) {
    return (
      <Shell>
        <Card>
          <EmptyState
            title="No routes set up yet"
            description="A route groups the stores you service on a given day. Create one, then assign accounts to it from the customer list."
          />
        </Card>
      </Shell>
    )
  }

  const templateId = firstValue(params.template) ?? active[0].id
  const template = active.find((t) => t.id === templateId) ?? active[0]

  // Default to the next occurrence of the route's own day.
  const serviceDate = firstValue(params.date) ?? nextDateFor(template.dayOfWeek, ctx.organization.timezone)

  const [{ due, notDue, dayName }, members, vehicles] = await Promise.all([
    getAccountsDue(ctx, { routeTemplateId: template.id, serviceDate }),
    db(ctx).membership.findMany({
      where: { status: 'ACTIVE' },
      select: { user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { joinedAt: 'asc' },
    }),
    listVehicles(ctx),
  ])

  return (
    <Shell>
      <PlannerFilters
        templates={active.map((t) => ({ id: t.id, name: t.name, dayOfWeek: t.dayOfWeek }))}
        templateId={template.id}
        serviceDate={serviceDate}
      />

      <RoutePlanner
        templates={active.map((t) => ({
          id: t.id,
          name: t.name,
          dayOfWeek: t.dayOfWeek,
          runnerId: t.runnerId,
          vehicleId: t.vehicleId,
        }))}
        runners={members.map((mm) => ({
          id: mm.user.id,
          name: `${mm.user.firstName} ${mm.user.lastName}`.trim(),
        }))}
        vehicles={vehicles.filter((v) => v.active).map((v) => ({ id: v.id, name: v.name }))}
        serviceDate={serviceDate}
        templateId={template.id}
        due={due}
        notDue={notDue}
        dayName={dayName}
        currency={ctx.organization.currency}
      />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <Link
        href="/routes"
        className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-navy-600 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Routes
      </Link>

      <div>
        <h1 className="text-xl font-extrabold text-ink">Plan a route</h1>
        <p className="text-sm text-ink-muted">
          Pick a day and see which accounts are due. Overdue ones come first.
        </p>
      </div>

      {children}
    </div>
  )
}

const DAY_INDEX: Record<string, number> = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
}

function nextDateFor(dayOfWeek: string | null, timezone: string): string {
  const today = new Date()
  if (!dayOfWeek) return localDateString(today, timezone)

  const target = DAY_INDEX[dayOfWeek]
  const local = new Date(`${localDateString(today, timezone)}T00:00:00.000Z`)
  const delta = (target - local.getUTCDay() + 7) % 7
  local.setUTCDate(local.getUTCDate() + delta)
  return local.toISOString().slice(0, 10)
}
