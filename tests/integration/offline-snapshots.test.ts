import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout } from '@/server/services/sale.service'
import {
  getTruckBalances,
  getTruckCatalog,
  getRouteDay,
} from '@/server/services/offline.service'
import { addMember, createCustomer, createProduct, createTestOrg, type TestOrg } from '../helpers'

/**
 * The reads a phone is allowed to keep (docs/05 §2).
 *
 * Two properties are load-bearing. Every snapshot says when it was true, or the
 * UI has no honest way to label it. And a snapshot is the truck's, not the
 * warehouse's — a runner offline in a store needs what is on their own vehicle,
 * and must never be handed another runner's.
 */
describe('what the phone is allowed to keep', () => {
  let org: TestOrg
  let runner: Awaited<ReturnType<typeof addMember>>
  let other: Awaited<ReturnType<typeof addMember>>
  let product: Awaited<ReturnType<typeof createProduct>>
  let customerId: string

  beforeEach(async () => {
    org = await createTestOrg()
    runner = await addMember(org, 'runner', { firstName: 'Mike', lastName: 'Donnelly' })
    other = await addMember(org, 'runner', { firstName: 'Sarah', lastName: 'Nguyen' })
    customerId = (await createCustomer(org.organizationId)).id

    product = await createProduct(org.organizationId, {
      name: 'Takis Fuego', unitsPerCase: 12, casePrice: '20.00', costPerBaseUnit: '1.200000',
      taxable: false,
    })
    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 200, unitCost: '14.40' }],
    })

    for (const [member, truckNumber, cases] of [
      [runner, '2', 10],
      [other, '3', 4],
    ] as const) {
      const vehicle = await createVehicle(org.ownerCtx, {
        name: `Truck #${truckNumber}`, truckNumber, active: true, assignedUserId: member.userId,
      })
      await db(org.ownerCtx).membership.updateMany({
        where: { userId: member.userId },
        data: { defaultVehicleId: vehicle.id },
      })
      await moveTruckStock(org.ownerCtx, {
        vehicleId: vehicle.id,
        warehouseLocationId: org.warehouseLocationId,
        direction: 'LOAD',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: cases }],
      })
    }
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  it('stamps every snapshot with when it was true', async () => {
    const before = Date.now()
    const [day, catalog, balances] = await Promise.all([
      getRouteDay(runner.ctx),
      getTruckCatalog(runner.ctx),
      getTruckBalances(runner.ctx),
    ])

    for (const snapshot of [day, catalog, balances]) {
      const asOf = Date.parse(snapshot.asOf)
      expect(Number.isNaN(asOf)).toBe(false)
      expect(asOf).toBeGreaterThanOrEqual(before - 1_000)
    }
  })

  it('reports this runner’s truck, not the one parked next to it', async () => {
    const mine = await getTruckBalances(runner.ctx)
    const theirs = await getTruckBalances(other.ctx)

    expect(mine.locationName).toBe('Truck #2')
    expect(mine.balances).toEqual([{ productId: product.id, quantity: 120 }])

    expect(theirs.locationName).toBe('Truck #3')
    expect(theirs.balances).toEqual([{ productId: product.id, quantity: 48 }])
  })

  it('carries prices as decimal strings, never as numbers', async () => {
    const catalog = await getTruckCatalog(runner.ctx)
    const item = catalog.items.find((row) => row.productId === product.id)

    expect(item).toBeDefined()
    for (const uom of item!.uoms) {
      expect(typeof uom.price).toBe('string')
      expect(uom.price).toMatch(/^-?\d+\.\d{2}$/)
    }
    expect(item!.uoms.find((uom) => uom.baseUnitsPerUom === 12)?.price).toBe('20.00')
  })

  it('moves with the truck: a sale changes the balance, not the catalogue', async () => {
    const beforeCatalog = await getTruckCatalog(runner.ctx)

    await checkout(runner.ctx, {
      customerId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 2 }],
    })

    const afterBalances = await getTruckBalances(runner.ctx)
    const afterCatalog = await getTruckCatalog(runner.ctx)

    expect(afterBalances.balances[0].quantity).toBe(120 - 24)
    expect(afterCatalog.items).toEqual(beforeCatalog.items)
  })

  it('shows an empty truck as empty rather than falling back to the warehouse', async () => {
    const stranger = await addMember(org, 'runner', { firstName: 'Ray', lastName: 'Boyd' })
    const vehicle = await createVehicle(org.ownerCtx, {
      name: 'Truck #9', truckNumber: '9', active: true, assignedUserId: stranger.userId,
    })
    await db(org.ownerCtx).membership.updateMany({
      where: { userId: stranger.userId },
      data: { defaultVehicleId: vehicle.id },
    })

    const balances = await getTruckBalances(stranger.ctx)
    expect(balances.locationName).toBe('Truck #9')
    expect(balances.balances).toEqual([])
  })

  it('gives a runner with no route today an empty day, not an error', async () => {
    const day = await getRouteDay(runner.ctx)
    expect(day.route).toBeNull()
    expect(day.otherRoutes).toEqual([])
  })
})
