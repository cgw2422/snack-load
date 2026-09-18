import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout } from '@/server/services/sale.service'
import { recordPayment } from '@/server/services/payment.service'
import { buildRoute, saveRouteTemplate } from '@/server/services/route.service'
import { arriveAtStop, completeStop, startRoute } from '@/server/services/routerun.service'
import { findBalanceDrift } from '@/server/services/inventory.service'
import { queuedMutationSchema, repricedAgainst } from '@/lib/schemas/offline'
import { checkoutSchema, recordPaymentSchema } from '@/lib/schemas/sales'
import { stopOutcomeSchema } from '@/lib/schemas/routes'
import { m, toAmountString } from '@/server/domain/money'
import { localDateString } from '@/lib/dates'
import {
  addMember,
  balanceOf,
  createCustomer,
  createProduct,
  createTestOrg,
  type TestOrg,
} from '../helpers'

/**
 * What happens when a runner's day reaches the server late (docs/05 §3).
 *
 * The exit criterion for this phase is one sentence: **queued sales replay
 * without double-posting.** These tests take the path a queued mutation
 * actually travels — the envelope, the same schema a live submit is validated
 * by, the same service the Server Action calls — and replay it the way a flaky
 * connection would.
 */
describe('replaying a queued day', () => {
  let org: TestOrg
  let runner: Awaited<ReturnType<typeof addMember>>
  let office: Awaited<ReturnType<typeof addMember>>
  let customerId: string
  let product: Awaited<ReturnType<typeof createProduct>>
  let truckLocation: string

  beforeEach(async () => {
    org = await createTestOrg()
    runner = await addMember(org, 'runner', { firstName: 'Mike', lastName: 'Donnelly' })
    office = await addMember(org, 'office', { firstName: 'Pat', lastName: 'Sandoval' })

    const customer = await createCustomer(org.organizationId)
    customerId = customer.id

    product = await createProduct(org.organizationId, {
      name: 'Takis Fuego', unitsPerCase: 12, casePrice: '20.00', costPerBaseUnit: '1.200000',
      taxable: false,
    })
    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 200, unitCost: '14.40' }],
    })

    const vehicle = await createVehicle(org.ownerCtx, {
      name: 'Truck #2', truckNumber: '2', active: true, assignedUserId: runner.userId,
    })
    truckLocation = (await db(org.ownerCtx).vehicle.findFirstOrThrow({ where: { id: vehicle.id } }))
      .locationId
    await db(org.ownerCtx).membership.updateMany({
      where: { userId: runner.userId },
      data: { defaultVehicleId: vehicle.id },
    })
    await moveTruckStock(org.ownerCtx, {
      vehicleId: vehicle.id,
      warehouseLocationId: org.warehouseLocationId,
      direction: 'LOAD',
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 150 }],
    })
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  const DAYS = [
    'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY',
  ] as const

  /** Today's route, with this store on it, started and arrived at. */
  async function stopForToday(): Promise<string> {
    const today = localDateString(new Date(), org.ownerCtx.organization.timezone)
    const dayOfWeek = DAYS[new Date(`${today}T12:00:00Z`).getUTCDay()]
    const template = await saveRouteTemplate(org.ownerCtx, null, {
      name: `Route ${randomUUID().slice(0, 6)}`,
      dayOfWeek,
      defaultRunnerUserId: runner.userId,
      active: true,
    })
    // The store has to be due today for the route to build at all.
    await db(org.ownerCtx).customerSchedule.create({
      data: {
        organizationId: org.organizationId,
        customerId,
        routeTemplateId: template.id,
        frequency: 'WEEKLY',
        dayOfWeek,
      },
    })

    const route = await buildRoute(org.ownerCtx, {
      routeTemplateId: template.id,
      serviceDate: today,
      runnerUserId: runner.userId,
      optimize: false,
    })

    await startRoute(runner.ctx, route.routeId)
    const stop = await db(org.ownerCtx).routeStop.findFirstOrThrow({
      where: { routeId: route.routeId, customerId },
    })
    await arriveAtStop(runner.ctx, stop.id)
    return stop.id
  }

  /**
   * One queued sale, sent the way the endpoint sends it.
   *
   * Deliberately goes through the envelope and both schemas rather than calling
   * `checkout` directly: the point is that what the queue holds is accepted
   * unchanged by the rules a live submit is held to.
   */
  async function sendQueuedSale(input: {
    idempotencyKey: string
    quantity: number
    clientEstimate?: string
    payment?: { method: 'CASH'; amount: string }
  }) {
    const envelope = queuedMutationSchema.parse({
      payload: {
        customerId,
        idempotencyKey: input.idempotencyKey,
        lines: [
          { productId: product.id, productUomId: product.caseUomId, quantity: input.quantity },
        ],
        ...(input.payment ? { payment: input.payment } : {}),
      },
      occurredAtClient: new Date().toISOString(),
      ...(input.clientEstimate ? { clientEstimate: input.clientEstimate } : {}),
    })

    const result = await checkout(runner.ctx, checkoutSchema.parse(envelope.payload))
    return { ...result, repriced: repricedAgainst(envelope.clientEstimate, result.total) }
  }

  // ── the exit criterion ────────────────────────────────────────────────────

  it('posts one sale however many times the queue sends it', async () => {
    const key = randomUUID()
    const truckBefore = await balanceOf(truckLocation, product.id)

    const first = await sendQueuedSale({ idempotencyKey: key, quantity: 3 })
    expect(first.replayed).toBe(false)

    // The response was lost four times. The queue cannot tell, so it sends again.
    for (let attempt = 0; attempt < 4; attempt++) {
      const again = await sendQueuedSale({ idempotencyKey: key, quantity: 3 })
      expect(again.replayed).toBe(true)
      expect(again.saleId).toBe(first.saleId)
      expect(again.saleNumber).toBe(first.saleNumber)
      expect(again.receiptNumber).toBe(first.receiptNumber)
      expect(again.total).toBe(first.total)
    }

    expect(await db(org.ownerCtx).sale.count()).toBe(1)
    // And stock came off once. A second deduction is the failure that makes
    // this unrecoverable — a truck that is short by a case nobody sold.
    expect(await balanceOf(truckLocation, product.id)).toBe(truckBefore - 36)
    expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
  })

  it('posts one sale when the whole day is replayed at once', async () => {
    const keys = Array.from({ length: 5 }, () => randomUUID())
    for (const key of keys) await sendQueuedSale({ idempotencyKey: key, quantity: 2 })

    // The runner comes out of a dead zone and everything goes again.
    for (const key of keys) await sendQueuedSale({ idempotencyKey: key, quantity: 2 })

    expect(await db(org.ownerCtx).sale.count()).toBe(5)
    expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
  })

  it('posts one sale when two replays race each other', async () => {
    const key = randomUUID()

    // Two tabs, or a reconnect and a manual retry at the same instant.
    const settled = await Promise.allSettled([
      sendQueuedSale({ idempotencyKey: key, quantity: 4 }),
      sendQueuedSale({ idempotencyKey: key, quantity: 4 }),
    ])

    const posted = settled.filter((entry) => entry.status === 'fulfilled')
    expect(posted.length).toBeGreaterThanOrEqual(1)
    expect(await db(org.ownerCtx).sale.count()).toBe(1)
    expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
  })

  // ── intent, not money ─────────────────────────────────────────────────────

  it('prices the sale on arrival, not from what the client was shown', async () => {
    const key = randomUUID()

    // The price went up while the runner was offline.
    await db(org.ownerCtx).productUom.updateMany({
      where: { productId: product.id, code: 'CASE' },
      data: { price: '25.00' },
    })

    const result = await sendQueuedSale({
      idempotencyKey: key,
      quantity: 2,
      clientEstimate: '40.00',
    })

    // The server charged its own figure, and said so.
    expect(result.total).toBe('50.00')
    expect(result.repriced).toBe(true)
  })

  it('says nothing about re-pricing when the total is unchanged', async () => {
    const result = await sendQueuedSale({
      idempotencyKey: randomUUID(),
      quantity: 2,
      clientEstimate: '40.00',
    })
    expect(result.total).toBe('40.00')
    expect(result.repriced).toBe(false)

    // Trailing zeros are the same money, not a re-price.
    expect(repricedAgainst('40.0', '40.00')).toBe(false)
    expect(repricedAgainst(undefined, '40.00')).toBe(false)
  })

  it('refuses a queued sale the truck cannot cover, rather than posting it short', async () => {
    // Stock sold to someone else while this one sat in the queue.
    await expect(
      sendQueuedSale({ idempotencyKey: randomUUID(), quantity: 500 }),
    ).rejects.toThrow(/not enough stock/i)

    expect(await db(org.ownerCtx).sale.count()).toBe(0)
  })

  // ── payments ──────────────────────────────────────────────────────────────

  it('records one payment however many times it is replayed', async () => {
    const sale = await sendQueuedSale({ idempotencyKey: randomUUID(), quantity: 5 })
    const key = randomUUID()

    const send = () =>
      recordPayment(
        office.ctx,
        recordPaymentSchema.parse(
          queuedMutationSchema.parse({
            payload: {
              customerId,
              method: 'CASH',
              amount: '40.00',
              strategy: 'OLDEST_FIRST',
              idempotencyKey: key,
            },
          }).payload,
        ),
      )

    const first = await send()
    for (let attempt = 0; attempt < 3; attempt++) {
      const again = await send()
      expect(again.replayed).toBe(true)
      expect(again.paymentId).toBe(first.paymentId)
    }

    expect(await db(org.ownerCtx).payment.count()).toBe(1)
    const row = await db(org.ownerCtx).sale.findUniqueOrThrow({ where: { id: sale.saleId } })
    expect(toAmountString(row.balanceDue)).toBe(toAmountString(m(sale.total).minus(40)))
  })

  // ── stop completion ───────────────────────────────────────────────────────

  describe('finishing a stop', () => {
    const todaysStop = () => stopForToday()

    const finish = (stopId: string, outcome: 'COMPLETED' | 'STORE_CLOSED' = 'COMPLETED') =>
      completeStop(
        runner.ctx,
        stopOutcomeSchema.parse(
          queuedMutationSchema.parse({ payload: { stopId, outcome } }).payload,
        ),
      )

    it('is the same answer however many times it is replayed', async () => {
      const stopId = await todaysStop()

      const first = await finish(stopId)
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await finish(stopId)).toEqual(first)
      }

      const stop = await db(org.ownerCtx).routeStop.findUniqueOrThrow({ where: { id: stopId } })
      expect(stop.status).toBe('COMPLETED')
      // The visit moved the account's cycle on exactly once.
      const customer = await db(org.ownerCtx).customer.findUniqueOrThrow({ where: { id: customerId } })
      expect(customer.lastVisitAt).not.toBeNull()
    })

    it('refuses a different outcome for a stop that is already finished', async () => {
      const stopId = await todaysStop()
      await finish(stopId, 'COMPLETED')

      // "Closed" and "completed" are not the same visit, and quietly
      // overwriting one with the other would lose what happened.
      await expect(finish(stopId, 'STORE_CLOSED')).rejects.toThrow(/already marked completed/i)
    })
  })

  // ── the whole day, in order ───────────────────────────────────────────────

  it('replays a stop’s sale, payment and completion in order and exactly once', async () => {
    const stopId = await stopForToday()
    const stop = { id: stopId }

    const saleKey = randomUUID()
    const paymentKey = randomUUID()

    /** The queue's own order: sale, then the cash for it, then the stop. */
    const day = [
      () => sendQueuedSale({ idempotencyKey: saleKey, quantity: 3 }),
      () =>
        recordPayment(office.ctx, {
          customerId, method: 'CASH', amount: '60.00',
          strategy: 'OLDEST_FIRST', idempotencyKey: paymentKey,
        }),
      () => finishStop(stop.id),
    ]

    for (const step of day) await step()
    // The whole thing goes again after a reconnect.
    for (const step of day) await step()

    expect(await db(org.ownerCtx).sale.count()).toBe(1)
    expect(await db(org.ownerCtx).payment.count()).toBe(1)
    expect(
      (await db(org.ownerCtx).routeStop.findUniqueOrThrow({ where: { id: stop.id } })).status,
    ).toBe('COMPLETED')
    expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])

    async function finishStop(stopId: string) {
      await arriveAtStop(runner.ctx, stopId).catch(() => undefined)
      return completeStop(runner.ctx, { stopId, outcome: 'COMPLETED' })
    }
  })

  // ── what the envelope is allowed to carry ─────────────────────────────────

  it('never accepts money from the client as authoritative', async () => {
    // A crafted envelope claiming a total. The payload schema has no such
    // field, so it is dropped before it can reach anything (docs/05 §3).
    const envelope = queuedMutationSchema.parse({
      payload: {
        customerId,
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 2 }],
        total: '0.01',
        taxTotal: '0.00',
        saleNumber: 'S-99999',
      },
    })

    const parsed = checkoutSchema.parse(envelope.payload)
    expect(parsed).not.toHaveProperty('total')
    expect(parsed).not.toHaveProperty('saleNumber')

    const result = await checkout(runner.ctx, parsed)
    expect(result.total).toBe('40.00')
    expect(result.saleNumber).toMatch(/^S-\d+$/)
    expect(result.saleNumber).not.toBe('S-99999')
  })
})
