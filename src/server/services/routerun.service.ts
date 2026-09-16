import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { can, requirePermission } from '@/server/auth/context'
import { conflict, forbidden, notFound } from '@/lib/errors'
import { dateOnly, todayDateOnly } from '@/lib/dates'
import { haversineMiles } from '@/server/domain/routeOptimize'
import { nextDueDate, type DayName } from '@/server/domain/schedule'
import { writeAudit } from './audit.service'
import { FINISHED, getRoute, type RouteDetail } from './route.service'
import type { StopOutcomeInput } from '@/lib/schemas/routes'

/**
 * The runner's day (spec §21).
 *
 * Start the route, arrive at a stop, sell, complete it, move on. Every action
 * here is something someone does standing in or outside a store, so each one is
 * a single call with no preconditions the app cannot check for them.
 */

/** Only the person the route is assigned to may work it — or an admin covering. */
async function requireRouteAccess(ctx: AuthContext, routeId: string) {
  const route = await db(ctx).route.findFirst({
    where: { id: routeId },
    select: { id: true, runnerUserId: true, status: true, serviceDate: true, name: true },
  })
  if (!route) throw notFound('That route')

  if (route.runnerUserId !== ctx.userId && !can(ctx, 'route:assign')) {
    throw forbidden('That route is assigned to someone else.')
  }
  return route
}

export async function startRoute(
  ctx: AuthContext,
  routeId: string,
  odometer?: number | null,
): Promise<void> {
  requirePermission(ctx, 'routerun:start')
  const route = await requireRouteAccess(ctx, routeId)

  if (route.status === 'COMPLETED') throw conflict('That route is already finished.')
  if (route.status === 'CANCELLED') throw conflict('That route was cancelled.')
  // Starting twice is a double-tap, not an error worth blocking on.
  if (route.status === 'IN_PROGRESS') return

  const prisma = db(ctx)
  await prisma.$transaction(async (tx) => {
    await tx.route.update({
      where: { id: routeId },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        startOdometer: odometer ?? null,
      },
    })
    await writeAudit(tx, ctx, {
      action: 'route.started',
      entityType: 'Route',
      entityId: routeId,
      after: { name: route.name, odometer },
    })
  })
}

export async function arriveAtStop(
  ctx: AuthContext,
  stopId: string,
  position?: { latitude: number; longitude: number } | null,
): Promise<void> {
  requirePermission(ctx, 'routerun:start')
  const prisma = db(ctx)

  const stop = await prisma.routeStop.findFirst({
    where: { id: stopId },
    select: {
      id: true, status: true, routeId: true,
      customer: { select: { latitude: true, longitude: true } },
    },
  })
  if (!stop) throw notFound('That stop')
  await requireRouteAccess(ctx, stop.routeId)

  if (FINISHED.has(stop.status)) {
    throw conflict('That stop is already done.')
  }

  // How far the runner was from the store when they tapped arrive. Recorded for
  // the route report, never used to block them — GPS in a metal truck beside a
  // cooler is not evidence of anything.
  const distanceMiles =
    position && stop.customer.latitude && stop.customer.longitude
      ? haversineMiles(position, {
          latitude: Number(stop.customer.latitude),
          longitude: Number(stop.customer.longitude),
        })
      : null

  await prisma.$transaction(async (tx) => {
    await tx.routeStop.update({
      where: { id: stopId },
      data: {
        status: 'ARRIVED',
        arrivedAt: new Date(),
        ...(distanceMiles !== null ? { distanceMiles: distanceMiles.toFixed(2) } : {}),
      },
    })
    // Arriving at the first stop starts the route if nobody pressed start.
    await tx.route.updateMany({
      where: { id: stop.routeId, status: 'PLANNED' },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    })
  })
}

/**
 * Finishing a stop, however it went (spec §21).
 *
 * Completing advances the account's schedule; a no-sale or a closed store does
 * not, so the account stays due and turns up on the next run. That distinction
 * is the whole reason these are separate outcomes.
 */
export async function completeStop(
  ctx: AuthContext,
  input: StopOutcomeInput,
): Promise<{ routeCompleted: boolean; nextStopId: string | null }> {
  requirePermission(ctx, 'routerun:complete')
  const prisma = db(ctx)

  const stop = await prisma.routeStop.findFirst({
    where: { id: input.stopId },
    select: {
      id: true, status: true, routeId: true, customerId: true, sequence: true,
      route: { select: { id: true, serviceDate: true, routeTemplateId: true } },
    },
  })
  if (!stop) throw notFound('That stop')
  await requireRouteAccess(ctx, stop.routeId)

  if (FINISHED.has(stop.status)) throw conflict('That stop is already done.')

  if (input.outcome === 'RESCHEDULED' && !input.rescheduledToDate) {
    throw conflict('Choose the day this store should be visited instead.')
  }

  const now = new Date()

  const result = await prisma.$transaction(async (tx) => {
    await tx.routeStop.update({
      where: { id: stop.id },
      data: {
        status: input.outcome,
        completedAt: now,
        arrivedAt: stop.status === 'ARRIVED' ? undefined : now,
        outcomeReason: input.reason || null,
        notes: input.notes || null,
        rescheduledToDate: input.rescheduledToDate ? dateOnly(input.rescheduledToDate) : null,
      },
    })

    // Only a real visit moves the account's cycle on. A closed store is still
    // owed a visit, and pretending otherwise loses the distributor a sale.
    if (input.outcome === 'COMPLETED') {
      await tx.customer.update({
        where: { id: stop.customerId },
        data: { lastVisitAt: now },
      })

      if (stop.route.routeTemplateId) {
        const schedule = await tx.customerSchedule.findFirst({
          where: {
            customerId: stop.customerId,
            routeTemplateId: stop.route.routeTemplateId,
          },
          select: { id: true, frequency: true, dayOfWeek: true, intervalDays: true },
        })

        if (schedule) {
          const nextDue = nextDueDate(
            {
              frequency: schedule.frequency,
              dayOfWeek: schedule.dayOfWeek as DayName,
              intervalDays: schedule.intervalDays,
              lastServicedOn: stop.route.serviceDate,
            },
            stop.route.serviceDate,
          )
          await tx.customerSchedule.update({
            where: { id: schedule.id },
            data: { lastServicedOn: stop.route.serviceDate, nextDueOn: nextDue },
          })
          await tx.customer.update({
            where: { id: stop.customerId },
            data: { nextDueOn: nextDue },
          })
        }
      }
    }

    const remaining = await tx.routeStop.findMany({
      where: { routeId: stop.routeId, status: { notIn: [...FINISHED] as never[] } },
      orderBy: { sequence: 'asc' },
      select: { id: true },
    })

    if (remaining.length === 0) {
      await tx.route.update({
        where: { id: stop.routeId },
        data: { status: 'COMPLETED', completedAt: now },
      })
    }

    return { routeCompleted: remaining.length === 0, nextStopId: remaining[0]?.id ?? null }
  })

  return result
}

export async function addStopNote(
  ctx: AuthContext,
  stopId: string,
  note: string,
): Promise<void> {
  requirePermission(ctx, 'routerun:complete')
  const prisma = db(ctx)

  const stop = await prisma.routeStop.findFirst({
    where: { id: stopId },
    select: { id: true, routeId: true, notes: true },
  })
  if (!stop) throw notFound('That stop')
  await requireRouteAccess(ctx, stop.routeId)

  await prisma.routeStop.update({
    where: { id: stopId },
    data: { notes: stop.notes ? `${stop.notes}\n${note}` : note },
  })
}

export type RunnerDay = {
  route: RouteDetail | null
  /** Other routes assigned to this person today, e.g. stops covered for someone. */
  otherRoutes: { id: string; name: string; totalStops: number; completedStops: number }[]
}

/** Everything the runner screen needs for today, in one call. */
export async function getRunnerDay(
  ctx: AuthContext,
  args: { routeId?: string } = {},
): Promise<RunnerDay> {
  const prisma = db(ctx)
  const today = todayDateOnly(ctx.organization.timezone)

  const routes = await prisma.route.findMany({
    where: {
      serviceDate: today,
      runnerUserId: ctx.userId,
      status: { in: ['PLANNED', 'IN_PROGRESS'] },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, stops: { select: { status: true } } },
  })

  const chosenId = args.routeId ?? routes[0]?.id
  if (!chosenId) return { route: null, otherRoutes: [] }

  return {
    route: await getRoute(ctx, chosenId),
    otherRoutes: routes
      .filter((route) => route.id !== chosenId)
      .map((route) => ({
        id: route.id,
        name: route.name,
        totalStops: route.stops.length,
        completedStops: route.stops.filter((s) => FINISHED.has(s.status)).length,
      })),
  }
}
