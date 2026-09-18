import { Prisma } from '@/generated/prisma/client'
import type { DayOfWeek } from '@/generated/prisma/enums'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { can, requirePermission } from '@/server/auth/context'
import { conflict, forbidden, notFound } from '@/lib/errors'
import { dateOnly, todayDateOnly } from '@/lib/dates'
import { sum, toAmountString } from '@/server/domain/money'
import {
  DAY_NAMES,
  daysOverdue,
  describeFrequency,
  isDueOn,
  nextDueDate,
  type DayName,
} from '@/server/domain/schedule'
import {
  estimateRouteMinutes,
  optimizeStopOrder,
  pathMiles,
} from '@/server/domain/routeOptimize'
import { writeAudit } from './audit.service'
import type {
  BuildRouteInput,
  ReassignInput,
  RouteTemplateInput,
} from '@/lib/schemas/routes'

/**
 * Route planning and assignment (spec §12, §14).
 *
 * A RouteTemplate is the standing arrangement — "Route A, Tuesdays, Mike".
 * A Route is one dated run of it. Accounts belong to templates via
 * CustomerSchedule; a run materialises the accounts that are due.
 */

export type DueAccount = {
  customerId: string
  name: string
  accountNumber: string
  addressLine: string
  latitude: number | null
  longitude: number | null
  balance: string
  sequence: number
  frequencyLabel: string
  lastVisitAt: string | null
  daysOverdue: number
  /** Already on a route for this date. */
  alreadyScheduled: boolean
}

export type RouteTemplateSummary = {
  id: string
  name: string
  code: string | null
  color: string | null
  dayOfWeek: string | null
  runnerId: string | null
  runnerName: string | null
  vehicleId: string | null
  vehicleName: string | null
  active: boolean
  accountCount: number
}

export async function listRouteTemplates(ctx: AuthContext): Promise<RouteTemplateSummary[]> {
  requirePermission(ctx, 'route:read')

  const templates = await db(ctx).routeTemplate.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    select: {
      id: true, name: true, code: true, color: true, dayOfWeek: true, active: true,
      defaultRunner: { select: { id: true, firstName: true, lastName: true } },
      defaultVehicle: { select: { id: true, name: true } },
      _count: { select: { schedules: true } },
    },
  })

  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    code: template.code,
    color: template.color,
    dayOfWeek: template.dayOfWeek,
    runnerId: template.defaultRunner?.id ?? null,
    runnerName: template.defaultRunner
      ? `${template.defaultRunner.firstName} ${template.defaultRunner.lastName}`.trim()
      : null,
    vehicleId: template.defaultVehicle?.id ?? null,
    vehicleName: template.defaultVehicle?.name ?? null,
    active: template.active,
    accountCount: template._count.schedules,
  }))
}

export async function saveRouteTemplate(
  ctx: AuthContext,
  id: string | null,
  input: RouteTemplateInput,
): Promise<{ id: string }> {
  requirePermission(ctx, id ? 'route:update' : 'route:create')
  const prisma = db(ctx)

  const clash = await prisma.routeTemplate.findFirst({
    where: { name: input.name, ...(id ? { NOT: { id } } : {}) },
    select: { id: true },
  })
  if (clash) throw conflict(`You already have a route called ${input.name}.`)

  const data = {
    name: input.name,
    code: input.code || null,
    color: input.color || null,
    dayOfWeek: (input.dayOfWeek || null) as DayOfWeek | null,
    defaultRunnerUserId: input.defaultRunnerUserId || null,
    defaultVehicleId: input.defaultVehicleId || null,
    active: input.active,
    notes: input.notes || null,
  }

  return prisma.$transaction(async (tx) => {
    const template = id
      ? await tx.routeTemplate.update({ where: { id }, data, select: { id: true } })
      : await tx.routeTemplate.create({
          data: { organizationId: ctx.organizationId, ...data },
          select: { id: true },
        })

    await writeAudit(tx, ctx, {
      action: id ? 'route_template.updated' : 'route_template.created',
      entityType: 'RouteTemplate',
      entityId: template.id,
      after: { name: input.name, dayOfWeek: input.dayOfWeek },
    })

    return { id: template.id }
  })
}

/**
 * The accounts a route should visit on a date (spec §12).
 *
 * Overdue accounts are included and flagged, because an account missed last week
 * should turn up on the next run rather than waiting out its whole cycle.
 */
export async function getAccountsDue(
  ctx: AuthContext,
  args: {
    routeTemplateId: string
    serviceDate: string
    /** Stops on this route don't count as already scheduled — it is being rebuilt. */
    excludeRouteId?: string | null
  },
): Promise<{ due: DueAccount[]; notDue: DueAccount[]; dayName: string }> {
  requirePermission(ctx, 'route:read')
  const prisma = db(ctx)

  const serviceDate = dateOnly(args.serviceDate)
  const dayName = DAY_NAMES[serviceDate.getUTCDay()]

  const schedules = await prisma.customerSchedule.findMany({
    where: { routeTemplateId: args.routeTemplateId, active: true, customer: { active: true } },
    orderBy: { sequence: 'asc' },
    select: {
      sequence: true,
      frequency: true,
      dayOfWeek: true,
      intervalDays: true,
      lastServicedOn: true,
      customer: {
        select: {
          id: true, name: true, accountNumber: true, balance: true, lastVisitAt: true,
          latitude: true, longitude: true,
          addressLine1: true, city: true, state: true, postalCode: true,
        },
      },
    },
  })

  // Stops already on any route for this date, so the planner cannot
  // double-book a store between two runners.
  const existing = await prisma.routeStop.findMany({
    where: {
      route: { serviceDate },
      ...(args.excludeRouteId ? { NOT: { routeId: args.excludeRouteId } } : {}),
    },
    select: { customerId: true },
  })
  const scheduled = new Set(existing.map((s) => s.customerId))

  const due: DueAccount[] = []
  const notDue: DueAccount[] = []

  for (const schedule of schedules) {
    const shape = {
      frequency: schedule.frequency,
      dayOfWeek: schedule.dayOfWeek as DayName,
      intervalDays: schedule.intervalDays,
      lastServicedOn: schedule.lastServicedOn,
    }

    const account: DueAccount = {
      customerId: schedule.customer.id,
      name: schedule.customer.name,
      accountNumber: schedule.customer.accountNumber,
      addressLine: formatAddress(schedule.customer),
      latitude: schedule.customer.latitude ? Number(schedule.customer.latitude) : null,
      longitude: schedule.customer.longitude ? Number(schedule.customer.longitude) : null,
      balance: toAmountString(schedule.customer.balance),
      sequence: schedule.sequence,
      frequencyLabel: describeFrequency(schedule.frequency, schedule.intervalDays),
      lastVisitAt: schedule.customer.lastVisitAt?.toISOString() ?? null,
      daysOverdue: daysOverdue(shape, serviceDate),
      alreadyScheduled: scheduled.has(schedule.customer.id),
    }

    if (isDueOn(shape, serviceDate)) due.push(account)
    else notDue.push(account)
  }

  // Most overdue first: those are the ones a planner most wants to see.
  due.sort((a, b) => b.daysOverdue - a.daysOverdue || a.sequence - b.sequence)

  return { due, notDue, dayName }
}

export async function buildRoute(
  ctx: AuthContext,
  input: BuildRouteInput,
): Promise<{ routeId: string; stopCount: number; miles: string; minutes: number }> {
  requirePermission(ctx, 'route:create')
  const prisma = db(ctx)

  const serviceDate = dateOnly(input.serviceDate)

  const [template, existingRoute] = await Promise.all([
    prisma.routeTemplate.findFirst({
      where: { id: input.routeTemplateId },
      select: { id: true, name: true, defaultVehicleId: true },
    }),
    prisma.route.findFirst({
      where: { routeTemplateId: input.routeTemplateId, serviceDate },
      select: { id: true, status: true },
    }),
  ])
  if (!template) throw notFound('That route')

  if (existingRoute && existingRoute.status !== 'PLANNED') {
    throw conflict('That run has already started. Add or move stops on it instead.')
  }

  const { due } = await getAccountsDue(ctx, {
    routeTemplateId: input.routeTemplateId,
    serviceDate: input.serviceDate,
    excludeRouteId: existingRoute?.id ?? null,
  })

  const chosen = input.customerIds
    ? due.filter((account) => input.customerIds!.includes(account.customerId))
    : due.filter((account) => !account.alreadyScheduled)

  if (chosen.length === 0) {
    throw conflict('No accounts are due on that date. Pick another day or add stops by hand.')
  }

  // A route starts where the truck is loaded; ignoring that produces an order
  // that looks tidy on a map and wastes twenty minutes in the morning.
  const warehouse = await prisma.warehouse.findFirst({
    where: { isPrimary: true },
    select: { latitude: true, longitude: true },
  })

  const ordered = input.optimize
    ? optimizeStopOrder(
        chosen.map((account) => ({
          id: account.customerId,
          latitude: account.latitude,
          longitude: account.longitude,
        })),
        warehouse?.latitude && warehouse.longitude
          ? { latitude: Number(warehouse.latitude), longitude: Number(warehouse.longitude) }
          : null,
      ).ordered
    : chosen.map((account) => ({
        id: account.customerId,
        latitude: account.latitude,
        longitude: account.longitude,
      }))

  const miles = pathMiles(ordered)
  const minutes = estimateRouteMinutes({ miles, stopCount: ordered.length })

  return prisma.$transaction(async (tx) => {
    const routeId = existingRoute?.id
      ? (
          await tx.route.update({
            where: { id: existingRoute.id },
            data: {
              runnerUserId: input.runnerUserId,
              vehicleId: input.vehicleId || template.defaultVehicleId,
              plannedStops: ordered.length,
              plannedMiles: miles.toFixed(2),
              plannedMinutes: minutes,
            },
            select: { id: true },
          })
        ).id
      : (
          await tx.route.create({
            data: {
              organizationId: ctx.organizationId,
              routeTemplateId: template.id,
              serviceDate,
              name: template.name,
              runnerUserId: input.runnerUserId,
              vehicleId: input.vehicleId || template.defaultVehicleId,
              plannedStops: ordered.length,
              plannedMiles: miles.toFixed(2),
              plannedMinutes: minutes,
            },
            select: { id: true },
          })
        ).id

    // Rebuilding a planned route replaces its pending stops; anything already
    // worked is left exactly as it is.
    await tx.routeStop.deleteMany({ where: { routeId, status: 'PENDING' } })

    for (const [index, stop] of ordered.entries()) {
      await tx.routeStop.upsert({
        where: { routeId_customerId: { routeId, customerId: stop.id } },
        create: {
          organizationId: ctx.organizationId,
          routeId,
          customerId: stop.id,
          sequence: index + 1,
        },
        update: { sequence: index + 1 },
      })
    }

    await writeAudit(tx, ctx, {
      action: 'route.built',
      entityType: 'Route',
      entityId: routeId,
      after: {
        template: template.name,
        serviceDate: input.serviceDate,
        stopCount: ordered.length,
        optimized: input.optimize,
      },
    })

    return { routeId, stopCount: ordered.length, miles: miles.toFixed(2), minutes }
  })
}

export async function reorderStops(
  ctx: AuthContext,
  routeId: string,
  stopIds: string[],
): Promise<void> {
  requirePermission(ctx, 'route:update')
  const prisma = db(ctx)

  const stops = await prisma.routeStop.findMany({
    where: { routeId, id: { in: stopIds } },
    select: { id: true },
  })
  if (stops.length !== stopIds.length) {
    throw conflict('That order refers to stops which are no longer on this route.')
  }

  await prisma.$transaction(async (tx) => {
    // Sequences are pushed out of the way first: the column is unique per route
    // in spirit, and a straight renumber would collide mid-update.
    for (const [index, id] of stopIds.entries()) {
      await tx.routeStop.update({ where: { id }, data: { sequence: index + 1 + 10_000 } })
    }
    for (const [index, id] of stopIds.entries()) {
      await tx.routeStop.update({ where: { id }, data: { sequence: index + 1 } })
    }
  })
}

export async function optimizeRoute(
  ctx: AuthContext,
  routeId: string,
): Promise<{ miles: string; minutes: number; movedStops: number }> {
  requirePermission(ctx, 'route:optimize')
  const prisma = db(ctx)

  const route = await prisma.route.findFirst({
    where: { id: routeId },
    select: {
      id: true,
      stops: {
        where: { status: 'PENDING' },
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          sequence: true,
          customer: { select: { latitude: true, longitude: true } },
        },
      },
    },
  })
  if (!route) throw notFound('That route')
  if (route.stops.length < 2) {
    throw conflict('There is nothing to reorder on this route.')
  }

  const warehouse = await prisma.warehouse.findFirst({
    where: { isPrimary: true },
    select: { latitude: true, longitude: true },
  })

  const { ordered, totalMiles } = optimizeStopOrder(
    route.stops.map((stop) => ({
      id: stop.id,
      latitude: stop.customer.latitude ? Number(stop.customer.latitude) : null,
      longitude: stop.customer.longitude ? Number(stop.customer.longitude) : null,
    })),
    warehouse?.latitude && warehouse.longitude
      ? { latitude: Number(warehouse.latitude), longitude: Number(warehouse.longitude) }
      : null,
  )

  const before = route.stops.map((s) => s.id)
  const movedStops = ordered.filter((stop, index) => before[index] !== stop.id).length

  await reorderStops(ctx, routeId, ordered.map((s) => s.id))

  const minutes = estimateRouteMinutes({ miles: totalMiles, stopCount: ordered.length })
  await prisma.route.update({
    where: { id: routeId },
    data: { plannedMiles: totalMiles.toFixed(2), plannedMinutes: minutes },
  })

  return { miles: totalMiles.toFixed(2), minutes, movedStops }
}

export async function addStop(
  ctx: AuthContext,
  routeId: string,
  customerId: string,
): Promise<void> {
  requirePermission(ctx, 'route:update')
  const prisma = db(ctx)

  const [route, customer] = await Promise.all([
    prisma.route.findFirst({
      where: { id: routeId },
      select: { id: true, serviceDate: true, stops: { select: { sequence: true } } },
    }),
    prisma.customer.findFirst({ where: { id: customerId }, select: { id: true, name: true } }),
  ])
  if (!route) throw notFound('That route')
  if (!customer) throw notFound('That store')

  const clash = await prisma.routeStop.findFirst({
    where: { customerId, route: { serviceDate: route.serviceDate } },
    select: { route: { select: { name: true } } },
  })
  if (clash) {
    throw conflict(`${customer.name} is already on ${clash.route.name} that day.`)
  }

  const nextSequence = Math.max(0, ...route.stops.map((s) => s.sequence)) + 1

  await prisma.routeStop.create({
    data: {
      organizationId: ctx.organizationId,
      routeId,
      customerId,
      sequence: nextSequence,
    },
  })
}

export async function removeStop(ctx: AuthContext, stopId: string): Promise<void> {
  requirePermission(ctx, 'route:update')
  const prisma = db(ctx)

  const stop = await prisma.routeStop.findFirst({
    where: { id: stopId },
    select: { id: true, status: true },
  })
  if (!stop) throw notFound('That stop')
  if (stop.status !== 'PENDING') {
    throw conflict('That stop has already been worked. Leave it on the route for the record.')
  }

  await prisma.routeStop.delete({ where: { id: stopId } })
}

/**
 * Moving work between runners (spec §14).
 *
 * "Mike calls off; move his remaining stops to Sarah." The original route keeps
 * its history — the stops move, and RouteAssignmentHistory records who had them
 * and why.
 */
export async function reassignStops(
  ctx: AuthContext,
  input: ReassignInput,
): Promise<{ movedStops: number; targetRouteId: string }> {
  requirePermission(ctx, 'route:assign')
  const prisma = db(ctx)

  const route = await prisma.route.findFirst({
    where: { id: input.routeId },
    select: {
      id: true, name: true, serviceDate: true, routeTemplateId: true,
      runnerUserId: true, vehicleId: true,
      stops: {
        where: { status: 'PENDING' },
        orderBy: { sequence: 'asc' },
        select: { id: true, customerId: true },
      },
    },
  })
  if (!route) throw notFound('That route')

  const moving = input.stopIds
    ? route.stops.filter((stop) => input.stopIds!.includes(stop.id))
    : route.stops

  if (moving.length === 0) {
    throw conflict('There are no unworked stops left to move.')
  }

  const member = await prisma.membership.findFirst({
    where: { userId: input.toUserId, status: 'ACTIVE' },
    select: { userId: true, defaultVehicleId: true },
  })
  if (!member) throw notFound('That runner')

  return prisma.$transaction(async (tx) => {
    let targetRouteId = input.targetRouteId ?? null

    if (targetRouteId) {
      const target = await tx.route.findFirst({
        where: { id: targetRouteId, serviceDate: route.serviceDate },
        select: { id: true },
      })
      if (!target) throw conflict('That route is not running on the same day.')
    } else {
      // No destination named: find or create the day's route for this runner.
      // A template can only have one run per day, so a covering route gets its
      // own record rather than colliding with the original.
      const existing = await tx.route.findFirst({
        where: {
          serviceDate: route.serviceDate,
          runnerUserId: input.toUserId,
          status: { in: ['PLANNED', 'IN_PROGRESS'] },
        },
        select: { id: true },
      })

      targetRouteId =
        existing?.id ??
        (
          await tx.route.create({
            data: {
              organizationId: ctx.organizationId,
              serviceDate: route.serviceDate,
              name: `${route.name} (covering)`,
              runnerUserId: input.toUserId,
              vehicleId: member.defaultVehicleId,
            },
            select: { id: true },
          })
        ).id
    }

    const highest = await tx.routeStop.aggregate({
      where: { routeId: targetRouteId },
      _max: { sequence: true },
    })
    let sequence = (highest._max.sequence ?? 0) + 1

    for (const stop of moving) {
      await tx.routeStop.update({
        where: { id: stop.id },
        data: { routeId: targetRouteId, sequence: sequence++ },
      })
      await tx.routeAssignmentHistory.create({
        data: {
          organizationId: ctx.organizationId,
          routeId: route.id,
          routeStopId: stop.id,
          fromUserId: route.runnerUserId,
          toUserId: input.toUserId,
          reason: input.reason || null,
          createdByUserId: ctx.userId,
        },
      })
    }

    await tx.route.update({
      where: { id: route.id },
      data: { plannedStops: { decrement: moving.length } },
    })
    await tx.route.update({
      where: { id: targetRouteId },
      data: { plannedStops: { increment: moving.length } },
    })

    await writeAudit(tx, ctx, {
      action: 'route.reassigned',
      entityType: 'Route',
      entityId: route.id,
      after: {
        movedStops: moving.length,
        fromUserId: route.runnerUserId,
        toUserId: input.toUserId,
        targetRouteId,
        reason: input.reason,
      },
    })

    return { movedStops: moving.length, targetRouteId }
  })
}

export type RouteDetail = {
  id: string
  name: string
  serviceDate: string
  status: string
  runnerId: string
  runnerName: string
  vehicleName: string | null
  plannedMiles: string | null
  plannedMinutes: number | null
  startedAt: string | null
  completedAt: string | null
  salesTotal: string
  collectedTotal: string
  stops: RouteStopDetail[]
}

export type RouteStopDetail = {
  id: string
  sequence: number
  status: string
  customerId: string
  customerName: string
  accountNumber: string
  addressLine: string
  mapQuery: string
  latitude: number | null
  longitude: number | null
  balance: string
  phone: string | null
  notes: string | null
  outcomeReason: string | null
  arrivedAt: string | null
  completedAt: string | null
  saleTotal: string | null
  distanceMiles: string | null
}

export async function getRoute(ctx: AuthContext, routeId: string): Promise<RouteDetail> {
  const prisma = db(ctx)

  const route = await prisma.route.findFirst({
    where: { id: routeId },
    select: {
      id: true, name: true, serviceDate: true, status: true, runnerUserId: true,
      plannedMiles: true, plannedMinutes: true, startedAt: true, completedAt: true,
      runner: { select: { firstName: true, lastName: true } },
      vehicle: { select: { name: true } },
      sales: { where: { status: 'COMPLETED' }, select: { total: true, routeStopId: true } },
      stops: {
        orderBy: { sequence: 'asc' },
        select: {
          id: true, sequence: true, status: true, notes: true, outcomeReason: true,
          arrivedAt: true, completedAt: true, distanceMiles: true,
          customer: {
            select: {
              id: true, name: true, accountNumber: true, balance: true, phone: true,
              latitude: true, longitude: true,
              addressLine1: true, city: true, state: true, postalCode: true,
            },
          },
        },
      },
    },
  })
  if (!route) throw notFound('That route')

  // A runner may open their own route; anyone else needs org-wide read.
  if (!can(ctx, 'route:read') && route.runnerUserId !== ctx.userId) {
    throw forbidden('That route belongs to someone else.')
  }

  const payments = await prisma.payment.aggregate({
    where: { status: 'POSTED', routeStop: { routeId } },
    _sum: { amount: true },
  })

  const saleByStop = new Map(
    route.sales.filter((s) => s.routeStopId).map((s) => [s.routeStopId!, s.total]),
  )

  return {
    id: route.id,
    name: route.name,
    serviceDate: route.serviceDate.toISOString().slice(0, 10),
    status: route.status,
    runnerId: route.runnerUserId,
    runnerName: `${route.runner.firstName} ${route.runner.lastName}`.trim(),
    vehicleName: route.vehicle?.name ?? null,
    plannedMiles: route.plannedMiles?.toString() ?? null,
    plannedMinutes: route.plannedMinutes,
    startedAt: route.startedAt?.toISOString() ?? null,
    completedAt: route.completedAt?.toISOString() ?? null,
    salesTotal: toAmountString(
      // Summed as decimals, not floats: a route with forty sales on it is
      // exactly the case where accumulated binary error shows up as a cent
      // that nothing accounts for (docs/02 §M1).
      sum(route.sales.map((sale) => sale.total)),
    ),
    collectedTotal: toAmountString(payments._sum.amount ?? 0),
    stops: route.stops.map((stop) => ({
      id: stop.id,
      sequence: stop.sequence,
      status: stop.status,
      customerId: stop.customer.id,
      customerName: stop.customer.name,
      accountNumber: stop.customer.accountNumber,
      addressLine: formatAddress(stop.customer),
      mapQuery:
        stop.customer.latitude && stop.customer.longitude
          ? `${stop.customer.latitude},${stop.customer.longitude}`
          : formatAddress(stop.customer),
      latitude: stop.customer.latitude ? Number(stop.customer.latitude) : null,
      longitude: stop.customer.longitude ? Number(stop.customer.longitude) : null,
      balance: toAmountString(stop.customer.balance),
      phone: stop.customer.phone,
      notes: stop.notes,
      outcomeReason: stop.outcomeReason,
      arrivedAt: stop.arrivedAt?.toISOString() ?? null,
      completedAt: stop.completedAt?.toISOString() ?? null,
      saleTotal: saleByStop.has(stop.id) ? toAmountString(saleByStop.get(stop.id)!) : null,
      distanceMiles: stop.distanceMiles?.toString() ?? null,
    })),
  }
}

export type RouteListItem = {
  id: string
  name: string
  serviceDate: string
  status: string
  runnerName: string
  vehicleName: string | null
  completedStops: number
  totalStops: number
  salesTotal: string
}

export async function listRoutes(
  ctx: AuthContext,
  args: { from?: string; to?: string; runnerUserId?: string } = {},
): Promise<RouteListItem[]> {
  const prisma = db(ctx)

  // A runner without org-wide read sees only their own runs.
  const ownOnly = !can(ctx, 'route:read')
  if (ownOnly && !can(ctx, 'route:read_own')) {
    throw forbidden('You do not have access to routes.')
  }

  const today = todayDateOnly(ctx.organization.timezone)
  const from = args.from ? dateOnly(args.from) : addDays(today, -14)
  const to = args.to ? dateOnly(args.to) : addDays(today, 14)

  const routes = await prisma.route.findMany({
    where: {
      serviceDate: { gte: from, lte: to },
      ...(ownOnly ? { runnerUserId: ctx.userId } : {}),
      ...(args.runnerUserId ? { runnerUserId: args.runnerUserId } : {}),
    },
    orderBy: [{ serviceDate: 'desc' }, { name: 'asc' }],
    select: {
      id: true, name: true, serviceDate: true, status: true,
      runner: { select: { firstName: true, lastName: true } },
      vehicle: { select: { name: true } },
      stops: { select: { status: true } },
      sales: { where: { status: 'COMPLETED' }, select: { total: true } },
    },
  })

  return routes.map((route) => ({
    id: route.id,
    name: route.name,
    serviceDate: route.serviceDate.toISOString().slice(0, 10),
    status: route.status,
    runnerName: `${route.runner.firstName} ${route.runner.lastName}`.trim(),
    vehicleName: route.vehicle?.name ?? null,
    completedStops: route.stops.filter((s) => FINISHED.has(s.status)).length,
    totalStops: route.stops.length,
    salesTotal: toAmountString(
      // Summed as decimals, not floats: a route with forty sales on it is
      // exactly the case where accumulated binary error shows up as a cent
      // that nothing accounts for (docs/02 §M1).
      sum(route.sales.map((sale) => sale.total)),
    ),
  }))
}

export const FINISHED: ReadonlySet<string> = new Set([
  'COMPLETED', 'SKIPPED', 'NO_SALE', 'STORE_CLOSED', 'RESCHEDULED',
])

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

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

export { nextDueDate }
export type { Prisma }
