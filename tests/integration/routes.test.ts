import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import {
  addStop,
  buildRoute,
  getAccountsDue,
  getRoute,
  listRoutes,
  optimizeRoute,
  reassignStops,
  removeStop,
  reorderStops,
  saveRouteTemplate,
} from '@/server/services/route.service'
import {
  arriveAtStop,
  completeStop,
  getRunnerDay,
  startRoute,
} from '@/server/services/routerun.service'
import { addMember, createCustomer, createTestOrg, type TestOrg } from '../helpers'

/** Routes are where the schedule, the geography and the people meet. */
describe('routes', () => {
  let org: TestOrg
  let mike: Awaited<ReturnType<typeof addMember>>
  let sarah: Awaited<ReturnType<typeof addMember>>
  let templateId: string
  const customerIds: string[] = []

  // A Tuesday, so the fixtures line up with a weekly Tuesday route.
  const TUESDAY = '2026-09-22'
  const WEDNESDAY = '2026-09-23'

  beforeEach(async () => {
    org = await createTestOrg()
    mike = await addMember(org, 'runner', { firstName: 'Mike', lastName: 'Donnelly' })
    sarah = await addMember(org, 'runner', { firstName: 'Sarah', lastName: 'Nguyen' })
    customerIds.length = 0

    const template = await saveRouteTemplate(org.ownerCtx, null, {
      name: 'Route A',
      dayOfWeek: 'TUESDAY',
      defaultRunnerUserId: mike.userId,
      active: true,
    })
    templateId = template.id

    // Five stores strung out along a line, deliberately added out of order.
    const places: [string, number, number][] = [
      ['Country Corner', 40.5031, -81.6432],
      ['Joe\'s Marathon', 41.4489, -82.7079],
      ['Marathon #512', 40.5978, -81.5293],
      ['Speedway #214', 40.4898, -81.4457],
      ['BellStores', 40.5209, -81.4746],
    ]

    for (const [name, latitude, longitude] of places) {
      const customer = await createCustomer(org.organizationId, name)
      await db(org.ownerCtx).customer.update({
        where: { id: customer.id },
        data: { latitude: latitude.toString(), longitude: longitude.toString() },
      })
      await db(org.ownerCtx).customerSchedule.create({
        data: {
          organizationId: org.organizationId,
          customerId: customer.id,
          routeTemplateId: templateId,
          frequency: 'WEEKLY',
          dayOfWeek: 'TUESDAY',
        },
      })
      customerIds.push(customer.id)
    }
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  describe('who is due', () => {
    it('lists every account on its day', async () => {
      const { due, dayName } = await getAccountsDue(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
      })
      expect(dayName).toBe('TUESDAY')
      expect(due).toHaveLength(5)
    })

    it('lists nobody on a day the route does not run', async () => {
      const { due, notDue } = await getAccountsDue(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: WEDNESDAY,
      })
      expect(due).toHaveLength(0)
      expect(notDue).toHaveLength(5)
    })

    it('holds a fortnightly account back on its off week', async () => {
      await db(org.ownerCtx).customerSchedule.updateMany({
        where: { customerId: customerIds[0] },
        data: { frequency: 'BIWEEKLY', lastServicedOn: new Date('2026-09-15T00:00:00Z') },
      })

      const { due } = await getAccountsDue(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
      })
      expect(due.map((a) => a.customerId)).not.toContain(customerIds[0])
    })

    it('surfaces an overdue account first, and says how late it is', async () => {
      await db(org.ownerCtx).customerSchedule.updateMany({
        where: { customerId: customerIds[2] },
        data: { lastServicedOn: new Date('2026-08-18T00:00:00Z') },
      })

      const { due } = await getAccountsDue(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
      })
      expect(due[0].customerId).toBe(customerIds[2])
      expect(due[0].daysOverdue).toBeGreaterThan(20)
    })
  })

  describe('building a run', () => {
    it('creates a route with every due account as a stop', async () => {
      const result = await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
        runnerUserId: mike.userId,
        optimize: true,
      })
      expect(result.stopCount).toBe(5)

      const route = await getRoute(org.ownerCtx, result.routeId)
      expect(route.stops).toHaveLength(5)
      expect(route.status).toBe('PLANNED')
      expect(route.runnerName).toBe('Mike Donnelly')
    })

    it('numbers the stops in a sensible driving order', async () => {
      const { routeId } = await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
        runnerUserId: mike.userId,
        optimize: true,
      })

      const route = await getRoute(org.ownerCtx, routeId)
      expect(route.stops.map((s) => s.sequence)).toEqual([1, 2, 3, 4, 5])
      // The one store an hour north should not be stop three of five.
      const joes = route.stops.find((s) => s.customerName === "Joe's Marathon")!
      expect([1, 5]).toContain(joes.sequence)
    })

    it('estimates miles and minutes', async () => {
      const result = await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
        runnerUserId: mike.userId,
        optimize: true,
      })
      expect(Number(result.miles)).toBeGreaterThan(0)
      expect(result.minutes).toBeGreaterThan(0)
    })

    it('builds only the accounts asked for', async () => {
      const result = await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
        runnerUserId: mike.userId,
        customerIds: customerIds.slice(0, 2),
        optimize: true,
      })
      expect(result.stopCount).toBe(2)
    })

    it('refuses a day with nothing due rather than making an empty route', async () => {
      await expect(
        buildRoute(org.ownerCtx, {
          routeTemplateId: templateId,
          serviceDate: WEDNESDAY,
          runnerUserId: mike.userId,
          optimize: true,
        }),
      ).rejects.toThrow(/No accounts are due/i)
    })

    it('rebuilding a planned route replaces its stops rather than duplicating them', async () => {
      const first = await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
        runnerUserId: mike.userId,
        optimize: true,
      })
      const second = await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
        runnerUserId: sarah.userId,
        optimize: true,
      })

      expect(second.routeId).toBe(first.routeId)
      const route = await getRoute(org.ownerCtx, second.routeId)
      expect(route.stops).toHaveLength(5)
      // Rebuilding also reassigns the run to whoever it was rebuilt for.
      expect(route.runnerName).toBe('Sarah Nguyen')
    })

    it('will not rebuild a run that is already under way', async () => {
      const { routeId } = await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId, serviceDate: TUESDAY, runnerUserId: mike.userId, optimize: true,
      })
      await startRoute(mike.ctx, routeId)

      await expect(
        buildRoute(org.ownerCtx, {
          routeTemplateId: templateId, serviceDate: TUESDAY, runnerUserId: mike.userId, optimize: true,
        }),
      ).rejects.toThrow(/already started/i)
    })
  })

  describe('editing a run', () => {
    let routeId: string

    beforeEach(async () => {
      const built = await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
        runnerUserId: mike.userId,
        optimize: false,
      })
      routeId = built.routeId
    })

    it('reorders stops by hand', async () => {
      const before = await getRoute(org.ownerCtx, routeId)
      const reversed = [...before.stops].reverse().map((s) => s.id)

      await reorderStops(org.ownerCtx, routeId, reversed)

      const after = await getRoute(org.ownerCtx, routeId)
      expect(after.stops.map((s) => s.id)).toEqual(reversed)
      expect(after.stops.map((s) => s.sequence)).toEqual([1, 2, 3, 4, 5])
    })

    it('optimises an existing route and reports what moved', async () => {
      const result = await optimizeRoute(org.ownerCtx, routeId)
      expect(Number(result.miles)).toBeGreaterThan(0)
      expect(result.movedStops).toBeGreaterThan(0)
    })

    it('adds an unscheduled store', async () => {
      const walkIn = await createCustomer(org.organizationId, 'Walk-in Market')
      await addStop(org.ownerCtx, routeId, walkIn.id)

      const route = await getRoute(org.ownerCtx, routeId)
      expect(route.stops).toHaveLength(6)
      expect(route.stops[5].customerName).toBe('Walk-in Market')
    })

    it('will not put one store on two routes the same day', async () => {
      const other = await saveRouteTemplate(org.ownerCtx, null, {
        name: 'Route B', dayOfWeek: 'TUESDAY', active: true,
      })
      const otherRoute = await db(org.ownerCtx).route.create({
        data: {
          organizationId: org.organizationId,
          routeTemplateId: other.id,
          serviceDate: new Date(`${TUESDAY}T00:00:00Z`),
          name: 'Route B',
          runnerUserId: sarah.userId,
        },
        select: { id: true },
      })

      await expect(addStop(org.ownerCtx, otherRoute.id, customerIds[0])).rejects.toThrow(
        /already on/i,
      )
    })

    it('removes a pending stop but keeps a worked one for the record', async () => {
      const route = await getRoute(org.ownerCtx, routeId)
      await removeStop(org.ownerCtx, route.stops[0].id)
      expect((await getRoute(org.ownerCtx, routeId)).stops).toHaveLength(4)

      const remaining = await getRoute(org.ownerCtx, routeId)
      await startRoute(mike.ctx, routeId)
      await completeStop(mike.ctx, { stopId: remaining.stops[0].id, outcome: 'NO_SALE' })

      await expect(removeStop(org.ownerCtx, remaining.stops[0].id)).rejects.toThrow(
        /already been worked/i,
      )
    })
  })

  describe('moving work between runners', () => {
    let routeId: string

    beforeEach(async () => {
      const built = await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
        runnerUserId: mike.userId,
        optimize: false,
      })
      routeId = built.routeId
    })

    it("moves a runner's remaining stops to someone else", async () => {
      // Mike calls off after two stops.
      const route = await getRoute(org.ownerCtx, routeId)
      await startRoute(mike.ctx, routeId)
      await completeStop(mike.ctx, { stopId: route.stops[0].id, outcome: 'COMPLETED' })
      await completeStop(mike.ctx, { stopId: route.stops[1].id, outcome: 'COMPLETED' })

      const result = await reassignStops(org.ownerCtx, {
        routeId,
        toUserId: sarah.userId,
        reason: 'Mike called off',
      })

      expect(result.movedStops).toBe(3)

      const original = await getRoute(org.ownerCtx, routeId)
      // The two Mike worked stay on his route, with his name on them.
      expect(original.stops).toHaveLength(2)
      expect(original.stops.every((s) => s.status === 'COMPLETED')).toBe(true)

      const covering = await getRoute(org.ownerCtx, result.targetRouteId)
      expect(covering.stops).toHaveLength(3)
      expect(covering.runnerName).toBe('Sarah Nguyen')
    })

    it('records who had the work and why', async () => {
      await reassignStops(org.ownerCtx, {
        routeId,
        toUserId: sarah.userId,
        reason: 'Truck breakdown',
      })

      const history = await db(org.ownerCtx).routeAssignmentHistory.findMany()
      expect(history).toHaveLength(5)
      expect(history[0].fromUserId).toBe(mike.userId)
      expect(history[0].toUserId).toBe(sarah.userId)
      expect(history[0].reason).toBe('Truck breakdown')
    })

    it('moves only the stops named', async () => {
      const route = await getRoute(org.ownerCtx, routeId)
      const result = await reassignStops(org.ownerCtx, {
        routeId,
        stopIds: [route.stops[3].id, route.stops[4].id],
        toUserId: sarah.userId,
      })
      expect(result.movedStops).toBe(2)
      expect((await getRoute(org.ownerCtx, routeId)).stops).toHaveLength(3)
    })

    it('refuses when there is nothing left to move', async () => {
      await reassignStops(org.ownerCtx, { routeId, toUserId: sarah.userId })
      await expect(
        reassignStops(org.ownerCtx, { routeId, toUserId: sarah.userId }),
      ).rejects.toThrow(/no unworked stops/i)
    })

    it('keeps a runner from reassigning their own work', async () => {
      await expect(
        reassignStops(mike.ctx, { routeId, toUserId: sarah.userId }),
      ).rejects.toThrow(/permission/i)
    })
  })

  describe('running the route', () => {
    let routeId: string

    beforeEach(async () => {
      const built = await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
        runnerUserId: mike.userId,
        optimize: false,
      })
      routeId = built.routeId
    })

    it('starts the route', async () => {
      await startRoute(mike.ctx, routeId)
      expect((await getRoute(mike.ctx, routeId)).status).toBe('IN_PROGRESS')
    })

    it('treats a second start as a double-tap, not an error', async () => {
      await startRoute(mike.ctx, routeId)
      await expect(startRoute(mike.ctx, routeId)).resolves.toBeUndefined()
    })

    it('starts the route when the runner simply arrives somewhere', async () => {
      const route = await getRoute(mike.ctx, routeId)
      await arriveAtStop(mike.ctx, route.stops[0].id)

      const after = await getRoute(mike.ctx, routeId)
      expect(after.status).toBe('IN_PROGRESS')
      expect(after.stops[0].status).toBe('ARRIVED')
    })

    it('records how far away the runner was, without blocking them', async () => {
      const route = await getRoute(mike.ctx, routeId)
      await arriveAtStop(mike.ctx, route.stops[0].id, { latitude: 40.51, longitude: -81.65 })

      const after = await getRoute(mike.ctx, routeId)
      expect(Number(after.stops[0].distanceMiles)).toBeGreaterThanOrEqual(0)
    })

    it('hands back the next stop as each one is finished', async () => {
      await startRoute(mike.ctx, routeId)
      const route = await getRoute(mike.ctx, routeId)

      const first = await completeStop(mike.ctx, {
        stopId: route.stops[0].id,
        outcome: 'COMPLETED',
      })
      expect(first.routeCompleted).toBe(false)
      expect(first.nextStopId).toBe(route.stops[1].id)
    })

    it('finishes the route when the last stop is done', async () => {
      await startRoute(mike.ctx, routeId)
      const route = await getRoute(mike.ctx, routeId)

      let last
      for (const stop of route.stops) {
        last = await completeStop(mike.ctx, { stopId: stop.id, outcome: 'COMPLETED' })
      }

      expect(last!.routeCompleted).toBe(true)
      expect(last!.nextStopId).toBeNull()
      expect((await getRoute(mike.ctx, routeId)).status).toBe('COMPLETED')
    })

    it('advances the account cycle on a real visit', async () => {
      await startRoute(mike.ctx, routeId)
      const route = await getRoute(mike.ctx, routeId)
      await completeStop(mike.ctx, { stopId: route.stops[0].id, outcome: 'COMPLETED' })

      const schedule = await db(org.ownerCtx).customerSchedule.findFirst({
        where: { customerId: route.stops[0].customerId },
      })
      expect(schedule?.lastServicedOn?.toISOString().slice(0, 10)).toBe(TUESDAY)
      expect(schedule?.nextDueOn?.toISOString().slice(0, 10)).toBe('2026-09-29')
    })

    it('leaves a closed store still owed a visit', async () => {
      // This is the distinction that earns its keep: a no-sale must not push the
      // account a week out, or the distributor quietly loses the visit.
      await startRoute(mike.ctx, routeId)
      const route = await getRoute(mike.ctx, routeId)
      await completeStop(mike.ctx, {
        stopId: route.stops[0].id,
        outcome: 'STORE_CLOSED',
        reason: 'Closed for a funeral',
      })

      const schedule = await db(org.ownerCtx).customerSchedule.findFirst({
        where: { customerId: route.stops[0].customerId },
      })
      expect(schedule?.lastServicedOn).toBeNull()

      const { due } = await getAccountsDue(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: '2026-09-29',
      })
      expect(due.map((a) => a.customerId)).toContain(route.stops[0].customerId)
    })

    it('needs a date when a stop is rescheduled', async () => {
      await startRoute(mike.ctx, routeId)
      const route = await getRoute(mike.ctx, routeId)
      await expect(
        completeStop(mike.ctx, { stopId: route.stops[0].id, outcome: 'RESCHEDULED' }),
      ).rejects.toThrow(/day this store should be visited/i)
    })

    it('gives the same answer when the same outcome is sent twice', async () => {
      await startRoute(mike.ctx, routeId)
      const route = await getRoute(mike.ctx, routeId)

      const first = await completeStop(mike.ctx, {
        stopId: route.stops[0].id, outcome: 'COMPLETED',
      })
      const again = await completeStop(mike.ctx, {
        stopId: route.stops[0].id, outcome: 'COMPLETED',
      })

      // A stop finished on a dead cell tower gets queued and sent again when
      // the signal returns. The replay must not read as a failure (docs/05 §3).
      expect(again).toEqual(first)

      const after = await getRoute(mike.ctx, routeId)
      expect(after.stops[0].status).toBe('COMPLETED')
      expect(after.stops.filter((stop) => stop.status === 'COMPLETED')).toHaveLength(1)
    })

    it('refuses a different outcome for a stop that is already finished', async () => {
      await startRoute(mike.ctx, routeId)
      const route = await getRoute(mike.ctx, routeId)
      await completeStop(mike.ctx, { stopId: route.stops[0].id, outcome: 'COMPLETED' })

      // "Closed" and "completed" are not the same visit; overwriting one with
      // the other would lose what actually happened.
      await expect(
        completeStop(mike.ctx, { stopId: route.stops[0].id, outcome: 'STORE_CLOSED' }),
      ).rejects.toThrow(/already marked/i)
    })

    it("keeps one runner out of another runner's route", async () => {
      await expect(startRoute(sarah.ctx, routeId)).rejects.toThrow(/assigned to someone else/i)
      await expect(getRoute(sarah.ctx, routeId)).rejects.toThrow(/belongs to someone else/i)
    })

    it('lets an owner cover for a runner', async () => {
      await expect(startRoute(org.ownerCtx, routeId)).resolves.toBeUndefined()
    })
  })

  describe("the runner's day", () => {
    it('returns nothing when no route is assigned today', async () => {
      const day = await getRunnerDay(mike.ctx)
      expect(day.route).toBeNull()
    })

    it('shows only their own routes in the list', async () => {
      await buildRoute(org.ownerCtx, {
        routeTemplateId: templateId,
        serviceDate: TUESDAY,
        runnerUserId: mike.userId,
        optimize: false,
      })

      const mine = await listRoutes(mike.ctx)
      expect(mine).toHaveLength(1)

      const hers = await listRoutes(sarah.ctx)
      expect(hers).toHaveLength(0)

      const all = await listRoutes(org.ownerCtx)
      expect(all).toHaveLength(1)
    })
  })
})
