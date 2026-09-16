import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { firstValue } from '@/lib/searchParams'
import { formatShortDate, todayDateOnly } from '@/lib/dates'
import { listVehicles, suggestLoad } from '@/server/services/truckload.service'
import type { SuggestedLoadLine } from '@/server/services/truckload.service'
import { StockPageShell } from '@/components/stock/StockPageShell'
import { LoadTruckForm } from '@/components/stock/LoadTruckForm'

export const metadata: Metadata = { title: 'Load a truck' }

export default async function LoadPage(props: PageProps<'/inventory/load'>) {
  const ctx = await requireAuth()
  if (!can(ctx, 'inventory:load_truck')) redirect('/inventory')

  const rawDirection = firstValue((await props.searchParams).direction)
  const direction = rawDirection === 'UNLOAD' ? 'UNLOAD' : 'LOAD'

  const prisma = db(ctx)
  const [vehicles, warehouses, routeTemplates] = await Promise.all([
    listVehicles(ctx),
    prisma.inventoryLocation.findMany({
      where: { kind: 'WAREHOUSE', active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.routeTemplate.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, defaultVehicleId: true },
    }),
  ])

  // A load is attached to a dated run, not to the template it came from, so the
  // picker offers today's and tomorrow's routes. Route planning arrives in
  // Phase 4; until then this is usually empty and the field hides itself.
  const today = todayDateOnly(ctx.organization.timezone)
  const tomorrow = new Date(today)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)

  const runs = await prisma.route.findMany({
    where: {
      serviceDate: { gte: today, lte: tomorrow },
      status: { in: ['PLANNED', 'IN_PROGRESS'] },
    },
    orderBy: [{ serviceDate: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      serviceDate: true,
      runner: { select: { firstName: true } },
    },
  })

  const active = vehicles.filter((v) => v.active)
  const warehouseId = warehouses[0]?.id ?? ''

  // Suggestions are computed per truck up front: the picker switches instantly
  // rather than waiting on a round trip in a warehouse with poor reception.
  const suggestions: Record<string, SuggestedLoadLine[]> = {}
  if (direction === 'LOAD' && warehouseId) {
    await Promise.all(
      active.map(async (vehicle) => {
        const route = routeTemplates.find((r) => r.defaultVehicleId === vehicle.id)
        suggestions[vehicle.id] = await suggestLoad(ctx, {
          vehicleId: vehicle.id,
          routeTemplateId: route?.id,
          warehouseLocationId: warehouseId,
        })
      }),
    )
  }

  return (
    <StockPageShell
      title={direction === 'LOAD' ? 'Load a truck' : 'Unload a truck'}
      description={
        direction === 'LOAD'
          ? 'Move stock from the warehouse onto a truck before the route starts.'
          : 'Bring what came back off the truck and into the warehouse.'
      }
    >
      <LoadTruckForm
        vehicles={active.map((v) => ({
          id: v.id,
          name: v.name,
          truckNumber: v.truckNumber,
          runnerName: v.runnerName,
          locationId: v.locationId,
        }))}
        warehouses={warehouses}
        routes={runs.map((run) => ({
          id: run.id,
          name: `${run.name} · ${formatShortDate(run.serviceDate, ctx.organization.timezone)} · ${run.runner.firstName}`,
        }))}
        suggestions={suggestions}
        direction={direction}
      />
    </StockPageShell>
  )
}
