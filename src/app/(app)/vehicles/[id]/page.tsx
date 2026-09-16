import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound as nextNotFound, redirect } from 'next/navigation'
import { ArrowLeft, PackageMinus, PackagePlus } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { getLocationStock, listLedger } from '@/server/services/receiving.service'
import { formatMoney } from '@/server/domain/money'
import { formatQuantity } from '@/server/domain/uom'
import { Card, CardHeader } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { ButtonLink } from '@/components/ui/Button'
import { LedgerList } from '@/components/stock/LedgerList'
import { VehicleForm } from '@/components/vehicles/VehicleForm'

export const metadata: Metadata = { title: 'Truck' }

export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth()
  if (!can(ctx, 'inventory:read')) redirect('/')

  const { id } = await params
  const prisma = db(ctx)

  const vehicle = await prisma.vehicle.findFirst({
    where: { id },
    select: {
      id: true, name: true, truckNumber: true, licensePlate: true, active: true,
      notes: true, locationId: true,
      assignedUser: { select: { id: true, firstName: true, lastName: true } },
    },
  })
  if (!vehicle) nextNotFound()

  const [stock, ledger, members] = await Promise.all([
    getLocationStock(ctx, vehicle.locationId),
    listLedger(ctx, { locationId: vehicle.locationId, limit: 25 }),
    can(ctx, 'inventory:transfer')
      ? prisma.membership.findMany({
          where: { status: 'ACTIVE' },
          select: { user: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { joinedAt: 'asc' },
        })
      : [],
  ])

  const currency = ctx.organization.currency
  const totalValue = stock.reduce((sum, item) => sum + Number(item.value), 0)

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <Link
        href="/vehicles"
        className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-navy-600 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Trucks
      </Link>

      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold text-ink">{vehicle.name}</h1>
            <p className="mt-0.5 text-sm text-ink-muted">
              Truck #{vehicle.truckNumber}
              {vehicle.licensePlate ? ` · ${vehicle.licensePlate}` : ''}
            </p>
            <p className="text-sm text-ink-muted">
              {vehicle.assignedUser
                ? `${vehicle.assignedUser.firstName} ${vehicle.assignedUser.lastName}`.trim()
                : 'No runner assigned'}
            </p>
          </div>
          {vehicle.active ? <Pill tone="cash">In service</Pill> : <Pill>Out of service</Pill>}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-card bg-navy-50 px-3.5 py-3 text-navy-800 dark:bg-navy-900/60 dark:text-navy-100">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">On board</p>
          <p className="tnum mt-1 text-2xl font-extrabold">
            {formatMoney(totalValue.toFixed(2), currency)}
          </p>
        </div>
        <div className="rounded-card border border-line bg-surface-raised px-3.5 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink-subtle">Products</p>
          <p className="tnum mt-1 text-2xl font-extrabold text-ink">{stock.length}</p>
        </div>
      </div>

      {can(ctx, 'inventory:load_truck') && vehicle.active ? (
        <div className="grid grid-cols-2 gap-2.5">
          <ButtonLink href="/inventory/load" size="lg" variant="accent">
            <PackagePlus className="size-4" aria-hidden="true" />
            Load
          </ButtonLink>
          <ButtonLink href="/inventory/load?direction=UNLOAD" size="lg" variant="secondary">
            <PackageMinus className="size-4" aria-hidden="true" />
            Unload
          </ButtonLink>
        </div>
      ) : null}

      <Card>
        <CardHeader title="What's on the truck" />
        {stock.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-ink-muted">Empty. Load it before the route starts.</p>
        ) : (
          <ul className="divide-y divide-line">
            {stock.map((item) => (
              <li key={item.productId} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{item.name}</span>
                  <span className="block text-xs text-ink-muted">SKU {item.sku}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="tnum block text-sm font-bold text-ink">
                    {formatQuantity(item.quantity, item.unitsPerCase)}
                  </span>
                  <span className="tnum block text-xs text-ink-subtle">
                    {formatMoney(item.value, currency)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Recent movements" />
        <LedgerList entries={ledger} />
      </Card>

      {can(ctx, 'inventory:transfer') ? (
        <VehicleForm
          runners={members.map((mm) => ({
            id: mm.user.id,
            name: `${mm.user.firstName} ${mm.user.lastName}`.trim(),
          }))}
          vehicle={{
            id: vehicle.id,
            name: vehicle.name,
            truckNumber: vehicle.truckNumber,
            licensePlate: vehicle.licensePlate,
            runnerId: vehicle.assignedUser?.id ?? null,
            active: vehicle.active,
            notes: vehicle.notes,
          }}
        />
      ) : null}
    </div>
  )
}
