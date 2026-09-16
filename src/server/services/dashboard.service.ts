import { Prisma } from '@/generated/prisma/client'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { can } from '@/server/auth/context'
import { dayRangeInZone, todayDateOnly } from '@/lib/dates'
import { m, sum, toAmountString } from '@/server/domain/money'

/**
 * Dashboard reads (spec §6).
 *
 * Read-only, so Server Components may await these directly (docs/03 §4). Which
 * dashboard a person sees follows from their permissions, not their role name:
 * someone with org-wide `route:read` gets the operator view, someone with only
 * `route:read_own` gets the runner view.
 */

export type MetricTile = {
  key: string
  label: string
  value: string
  detail?: string
  tone: 'navy' | 'flame' | 'cash' | 'alert'
}

export type RouteSummary = {
  id: string
  name: string
  runnerName: string
  vehicleName: string | null
  status: string
  completedStops: number
  totalStops: number
  salesTotal: string
}

export type LowStockItem = {
  productId: string
  name: string
  sku: string
  quantity: number
  baseUnitsPerCase: number
  reorderPoint: number
}

export type ActivityItem = {
  id: string
  action: string
  summary: string
  actorName: string | null
  at: string
}

export type OperatorDashboard = {
  kind: 'operator'
  metrics: MetricTile[]
  routes: RouteSummary[]
  lowStock: LowStockItem[]
  activity: ActivityItem[]
}

export type NextStop = {
  stopId: string
  sequence: number
  customerId: string
  customerName: string
  address: string
  /** For a maps hand-off; coordinates when we have them, else the address. */
  mapQuery: string
  balance: string
  status: string
  distanceMiles: string | null
  durationMinutes: number | null
}

export type RunnerDashboard = {
  kind: 'runner'
  routeId: string | null
  routeName: string | null
  completedStops: number
  totalStops: number
  salesToday: string
  collectedToday: string
  nextStop: NextStop | null
  remaining: NextStop[]
}

export async function getOperatorDashboard(ctx: AuthContext): Promise<OperatorDashboard> {
  const prisma = db(ctx)
  const tz = ctx.organization.timezone
  const now = new Date()
  const today = dayRangeInZone(now, tz)
  const serviceDate = todayDateOnly(tz, now)

  const [salesAgg, receivablesAgg, routes, lowStockRows, inventoryValueRows, activity] =
    await Promise.all([
      prisma.sale.aggregate({
        where: { status: 'COMPLETED', occurredAt: today },
        _sum: { total: true },
        _count: true,
      }),
      prisma.sale.aggregate({
        where: { status: 'COMPLETED', balanceDue: { gt: 0 } },
        _sum: { balanceDue: true },
      }),
      prisma.route.findMany({
        where: { serviceDate },
        select: {
          id: true,
          name: true,
          status: true,
          runner: { select: { firstName: true, lastName: true } },
          vehicle: { select: { name: true, truckNumber: true } },
          stops: { select: { status: true } },
          sales: { where: { status: 'COMPLETED' }, select: { total: true } },
        },
        orderBy: { name: 'asc' },
      }),
      lowStockQuery(ctx.organizationId),
      inventoryValueQuery(ctx.organizationId),
      prisma.auditLog.findMany({
        take: 8,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          action: true,
          entityType: true,
          afterJson: true,
          createdAt: true,
          user: { select: { firstName: true, lastName: true } },
        },
      }),
    ])

  const routeSummaries: RouteSummary[] = routes.map((route) => ({
    id: route.id,
    name: route.name,
    runnerName: `${route.runner.firstName} ${route.runner.lastName}`.trim(),
    vehicleName: route.vehicle ? describeVehicle(route.vehicle) : null,
    status: route.status,
    completedStops: route.stops.filter((s) => FINISHED_STOP.has(s.status)).length,
    totalStops: route.stops.length,
    salesTotal: toAmountString(sum(route.sales.map((s) => s.total))),
  }))

  const totalStops = routeSummaries.reduce((n, r) => n + r.totalStops, 0)
  const completedStops = routeSummaries.reduce((n, r) => n + r.completedStops, 0)
  const running = routeSummaries.filter((r) => r.status === 'IN_PROGRESS').length

  const metrics: MetricTile[] = [
    {
      key: 'sales-today',
      label: 'Sales today',
      value: toAmountString(salesAgg._sum.total ?? 0),
      detail: `${salesAgg._count} ${salesAgg._count === 1 ? 'sale' : 'sales'}`,
      tone: 'cash',
    },
    {
      key: 'stops',
      label: 'Stops',
      value: `${completedStops} / ${totalStops}`,
      detail: totalStops === 0 ? 'No routes scheduled' : 'completed today',
      tone: 'navy',
    },
    {
      key: 'receivables',
      label: 'Outstanding',
      value: toAmountString(receivablesAgg._sum.balanceDue ?? 0),
      detail: 'owed by stores',
      tone: 'alert',
    },
    {
      key: 'inventory-value',
      label: 'Inventory value',
      value: toAmountString(inventoryValueRows),
      detail: 'at cost, all locations',
      tone: 'navy',
    },
    {
      key: 'runners',
      label: 'Runners out',
      value: `${running} of ${routeSummaries.length}`,
      detail: 'running routes',
      tone: 'flame',
    },
  ]

  return {
    kind: 'operator',
    metrics,
    routes: routeSummaries,
    lowStock: lowStockRows,
    activity: activity.map((entry) => ({
      id: entry.id,
      action: entry.action,
      summary: describeActivity(entry.action, entry.entityType, entry.afterJson),
      actorName: entry.user ? `${entry.user.firstName} ${entry.user.lastName}`.trim() : null,
      at: entry.createdAt.toISOString(),
    })),
  }
}

export async function getRunnerDashboard(ctx: AuthContext): Promise<RunnerDashboard> {
  const prisma = db(ctx)
  const tz = ctx.organization.timezone
  const now = new Date()
  const today = dayRangeInZone(now, tz)
  const serviceDate = todayDateOnly(tz, now)

  const route = await prisma.route.findFirst({
    where: { serviceDate, runnerUserId: ctx.userId, status: { in: ['PLANNED', 'IN_PROGRESS'] } },
    select: {
      id: true,
      name: true,
      stops: {
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          sequence: true,
          status: true,
          distanceMiles: true,
          durationMinutes: true,
          customer: {
            select: {
              id: true, name: true, balance: true, latitude: true, longitude: true,
              addressLine1: true, city: true, state: true, postalCode: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const [salesAgg, paymentsAgg] = await Promise.all([
    prisma.sale.aggregate({
      where: { status: 'COMPLETED', soldByUserId: ctx.userId, occurredAt: today },
      _sum: { total: true },
    }),
    prisma.payment.aggregate({
      where: { status: 'POSTED', receivedByUserId: ctx.userId, receivedAt: today },
      _sum: { amount: true },
    }),
  ])

  const stops = (route?.stops ?? []).map((stop) => ({
    stopId: stop.id,
    sequence: stop.sequence,
    customerId: stop.customer.id,
    customerName: stop.customer.name,
    address: formatAddress(stop.customer),
    mapQuery:
      stop.customer.latitude && stop.customer.longitude
        ? `${stop.customer.latitude},${stop.customer.longitude}`
        : formatAddress(stop.customer),
    balance: toAmountString(stop.customer.balance),
    status: stop.status,
    distanceMiles: stop.distanceMiles?.toString() ?? null,
    durationMinutes: stop.durationMinutes,
  }))

  const remaining = stops.filter(
    (_, i) => !FINISHED_STOP.has(route!.stops[i].status),
  )

  return {
    kind: 'runner',
    routeId: route?.id ?? null,
    routeName: route?.name ?? null,
    completedStops: stops.length - remaining.length,
    totalStops: stops.length,
    salesToday: toAmountString(salesAgg._sum.total ?? 0),
    collectedToday: toAmountString(paymentsAgg._sum.amount ?? 0),
    nextStop: remaining[0] ?? null,
    remaining: remaining.slice(1, 5),
  }
}

export function dashboardKindFor(ctx: AuthContext): 'operator' | 'runner' {
  return can(ctx, 'route:read') || can(ctx, 'report:read') ? 'operator' : 'runner'
}

function describeVehicle(vehicle: { name: string; truckNumber: string }): string {
  return vehicle.name.includes(vehicle.truckNumber)
    ? vehicle.name
    : `${vehicle.name} (#${vehicle.truckNumber})`
}

const FINISHED_STOP: ReadonlySet<string> = new Set([
  'COMPLETED', 'SKIPPED', 'NO_SALE', 'STORE_CLOSED', 'RESCHEDULED',
])

function formatAddress(c: {
  addressLine1: string | null
  city: string | null
  state: string | null
  postalCode: string | null
}): string {
  return [c.addressLine1, [c.city, c.state].filter(Boolean).join(', '), c.postalCode]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Raw SQL bypasses the tenant extension (docs/04 §5), so these two queries pass
 * organizationId explicitly and are reviewed as security-sensitive. They are raw
 * because summing `quantity × cost` across a join is not expressible in Prisma's
 * aggregate API, and pulling every balance row into Node to add it up would not
 * survive a real catalog.
 */
async function inventoryValueQuery(organizationId: string) {
  const rows = await db({ organizationId }).$queryRaw<{ value: string | null }[]>(
    Prisma.sql`
      SELECT COALESCE(SUM(b.quantity * b.avg_unit_cost), 0)::text AS value
      FROM inventory_balance b
      WHERE b.organization_id = ${organizationId}
        AND b.quantity > 0
    `,
  )
  return m(rows[0]?.value ?? 0)
}

async function lowStockQuery(organizationId: string): Promise<LowStockItem[]> {
  const rows = await db({ organizationId }).$queryRaw<
    {
      product_id: string
      name: string
      sku: string
      quantity: bigint | number
      reorder_point: number
      units_per_case: number | null
    }[]
  >(Prisma.sql`
    SELECT p.id           AS product_id,
           p.name,
           p.sku,
           COALESCE(SUM(b.quantity), 0) AS quantity,
           p.reorder_point_base_units   AS reorder_point,
           (SELECT u.base_units_per_uom
              FROM product_uom u
             WHERE u.product_id = p.id AND u.code = 'CASE'
             LIMIT 1)                   AS units_per_case
      FROM product p
      LEFT JOIN inventory_balance b
        ON b.product_id = p.id AND b.organization_id = ${organizationId}
     WHERE p.organization_id = ${organizationId}
       AND p.active = true
       AND p.reorder_point_base_units > 0
     GROUP BY p.id, p.name, p.sku, p.reorder_point_base_units
    HAVING COALESCE(SUM(b.quantity), 0) <= p.reorder_point_base_units
     ORDER BY COALESCE(SUM(b.quantity), 0) ASC
     LIMIT 6
  `)

  return rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    sku: row.sku,
    quantity: Number(row.quantity),
    baseUnitsPerCase: row.units_per_case ?? 1,
    reorderPoint: row.reorder_point,
  }))
}

function describeActivity(action: string, entityType: string, after: unknown): string {
  const data = (after ?? {}) as Record<string, unknown>
  switch (action) {
    case 'organization.created':
      return `Company created`
    case 'invitation.sent':
      return `Invited ${String(data.email ?? 'a teammate')}`
    case 'invitation.accepted':
      return `${String(data.email ?? 'A teammate')} joined the team`
    case 'sale.completed':
      return `Sale ${String(data.saleNumber ?? '')} · ${String(data.customerName ?? '')}`.trim()
    case 'payment.recorded':
      return `${String(data.amount ?? '')} collected from ${String(data.customerName ?? '')}`
    case 'inventory.received':
      return `Stock received from ${String(data.supplierName ?? 'a supplier')}`
    case 'truckload.confirmed':
      return `Truck ${String(data.truckNumber ?? '')} loaded`
    default:
      return `${action.replace(/[._]/g, ' ')} · ${entityType}`
  }
}
