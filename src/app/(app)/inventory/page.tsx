import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import {
  ArrowLeftRight, Boxes, ChevronRight, ClipboardCheck, PackageMinus, PackagePlus, Truck, Warehouse,
} from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { formatMoney } from '@/server/domain/money'
import { Prisma } from '@/generated/prisma/client'
import { Card, CardHeader } from '@/components/ui/Card'
import { LedgerList } from '@/components/stock/LedgerList'
import { listLedger } from '@/server/services/receiving.service'

export const metadata: Metadata = { title: 'Inventory' }

export default async function InventoryPage() {
  const ctx = await requireAuth()
  if (!can(ctx, 'inventory:read')) redirect('/')

  const prisma = db(ctx)
  const currency = ctx.organization.currency

  const [productCount, locations, lowStock, ledger] = await Promise.all([
    prisma.product.count({ where: { active: true } }),
    prisma.$queryRaw<{ id: string; name: string; kind: string; skus: bigint; value: string }[]>(
      Prisma.sql`
        SELECT l.id,
               l.name,
               l.kind,
               COUNT(*) FILTER (WHERE b.quantity <> 0) AS skus,
               COALESCE(SUM(b.quantity * b.avg_unit_cost), 0)::text AS value
          FROM inventory_location l
          LEFT JOIN inventory_balance b ON b.location_id = l.id
         WHERE l.organization_id = ${ctx.organizationId} AND l.active = true
         GROUP BY l.id, l.name, l.kind
         ORDER BY l.kind, l.name
      `,
    ),
    prisma.product.count({
      where: { active: true, reorderPointBaseUnits: { gt: 0 } },
    }),
    listLedger(ctx, { limit: 12 }),
  ])

  // Only offer what this person may actually do.
  const actions = [
    {
      href: '/inventory/products',
      label: 'Products',
      description: 'Your catalog, prices and stock levels',
      icon: Boxes,
      allowed: can(ctx, 'product:read'),
    },
    {
      href: '/inventory/receive',
      label: 'Receive stock',
      description: 'Bring a supplier shipment into the warehouse',
      icon: PackagePlus,
      allowed: can(ctx, 'inventory:receive'),
    },
    {
      href: '/inventory/load',
      label: 'Load a truck',
      description: 'Move stock onto a truck before the route starts',
      icon: Truck,
      allowed: can(ctx, 'inventory:load_truck'),
    },
    {
      href: '/inventory/load?direction=UNLOAD',
      label: 'Unload a truck',
      description: 'Bring back what did not sell',
      icon: PackageMinus,
      allowed: can(ctx, 'inventory:unload_truck'),
    },
    {
      href: '/inventory/transfer',
      label: 'Transfer stock',
      description: 'Move stock between warehouses and trucks',
      icon: ArrowLeftRight,
      allowed: can(ctx, 'inventory:transfer'),
    },
    {
      href: '/inventory/adjust',
      label: 'Adjust or count',
      description: 'Damage, expiry, shrinkage, samples or a physical count',
      icon: ClipboardCheck,
      allowed: can(ctx, 'inventory:adjust'),
    },
  ].filter((action) => action.allowed)

  const totalValue = locations.reduce((sum, l) => sum + Number(l.value), 0)

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <div>
        <h1 className="text-xl font-extrabold text-ink">Inventory</h1>
        <p className="text-sm text-ink-muted">
          One ledger across your warehouse and every truck.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-card bg-navy-50 px-3.5 py-3 text-navy-800 dark:bg-navy-900/60 dark:text-navy-100">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">Value at cost</p>
          <p className="tnum mt-1 text-2xl font-extrabold">
            {formatMoney(totalValue.toFixed(2), currency)}
          </p>
        </div>
        <div className="rounded-card bg-surface-raised border border-line px-3.5 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink-subtle">Products</p>
          <p className="tnum mt-1 text-2xl font-extrabold text-ink">{productCount}</p>
          <p className="mt-0.5 text-[11px] font-medium text-ink-subtle">
            {lowStock} with a reorder point
          </p>
        </div>
      </div>

      <Card>
        <CardHeader title="Where your stock is" />
        {locations.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-ink-muted">No stock locations yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {locations.map((location) => (
              <li key={location.id} className="flex items-center gap-3 px-4 py-3">
                {location.kind === 'WAREHOUSE' ? (
                  <Warehouse className="size-5 shrink-0 text-ink-subtle" aria-hidden="true" />
                ) : (
                  <Truck className="size-5 shrink-0 text-ink-subtle" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {location.name}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {Number(location.skus)} {Number(location.skus) === 1 ? 'product' : 'products'}
                  </span>
                </span>
                <span className="tnum shrink-0 text-sm font-bold text-ink">
                  {formatMoney(location.value, currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <ul className="divide-y divide-line">
          {actions.map((action) => (
            <li key={action.href}>
              <Link
                href={action.href}
                className="flex min-h-touch items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-navy-700 dark:text-navy-100">
                  <action.icon className="size-5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{action.label}</span>
                  <span className="block text-xs text-ink-muted">{action.description}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Recent movements"
          action={
            <span className="text-xs text-ink-subtle">Every number here is explainable</span>
          }
        />
        <LedgerList entries={ledger} />
      </Card>
    </div>
  )
}
