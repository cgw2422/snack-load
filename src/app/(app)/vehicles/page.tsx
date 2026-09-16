import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ChevronRight, PackageMinus, PackagePlus, Truck } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { listVehicles } from '@/server/services/truckload.service'
import { formatMoney } from '@/server/domain/money'
import { Card, CardHeader, EmptyState } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { ButtonLink } from '@/components/ui/Button'
import { VehicleForm } from '@/components/vehicles/VehicleForm'

export const metadata: Metadata = { title: 'Trucks' }

export default async function VehiclesPage() {
  const ctx = await requireAuth()
  if (!can(ctx, 'inventory:read')) redirect('/')

  const [vehicles, members] = await Promise.all([
    listVehicles(ctx),
    db(ctx).membership.findMany({
      where: { status: 'ACTIVE' },
      select: { user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { joinedAt: 'asc' },
    }),
  ])

  const currency = ctx.organization.currency
  const canManage = can(ctx, 'inventory:transfer')
  const canLoad = can(ctx, 'inventory:load_truck')

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <div>
        <h1 className="text-xl font-extrabold text-ink">Trucks</h1>
        <p className="text-sm text-ink-muted">
          Each truck carries its own inventory, separate from the warehouse.
        </p>
      </div>

      {canLoad && vehicles.some((v) => v.active) ? (
        <div className="grid grid-cols-2 gap-2.5">
          <ButtonLink href="/inventory/load" size="lg" variant="accent">
            <PackagePlus className="size-4" aria-hidden="true" />
            Load a truck
          </ButtonLink>
          <ButtonLink href="/inventory/load?direction=UNLOAD" size="lg" variant="secondary">
            <PackageMinus className="size-4" aria-hidden="true" />
            Unload
          </ButtonLink>
        </div>
      ) : null}

      <Card>
        <CardHeader title={`${vehicles.length} ${vehicles.length === 1 ? 'truck' : 'trucks'}`} />
        {vehicles.length === 0 ? (
          <EmptyState
            icon={<Truck className="size-8" aria-hidden="true" />}
            title="No trucks yet"
            description="Add a truck so stock can be loaded onto it."
          />
        ) : (
          <ul className="divide-y divide-line">
            {vehicles.map((vehicle) => (
              <li key={vehicle.id}>
                <Link
                  href={`/vehicles/${vehicle.id}`}
                  className="flex min-h-touch items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-navy-700 dark:text-navy-100">
                    <Truck className="size-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-ink">{vehicle.name}</span>
                      {!vehicle.active ? <Pill>Out of service</Pill> : null}
                    </span>
                    <span className="block truncate text-xs text-ink-muted">
                      {vehicle.runnerName ?? 'No runner assigned'}
                      {vehicle.licensePlate ? ` · ${vehicle.licensePlate}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tnum block text-sm font-bold text-ink">
                      {formatMoney(vehicle.stockValue, currency)}
                    </span>
                    <span className="block text-xs text-ink-subtle">
                      {vehicle.skuCount} {vehicle.skuCount === 1 ? 'product' : 'products'}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage ? (
        <VehicleForm
          runners={members.map((mm) => ({
            id: mm.user.id,
            name: `${mm.user.firstName} ${mm.user.lastName}`.trim(),
          }))}
        />
      ) : null}
    </div>
  )
}
