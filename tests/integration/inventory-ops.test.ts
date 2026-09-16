import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { findBalanceDrift } from '@/server/services/inventory.service'
import {
  adjustStock,
  getLocationStock,
  listLedger,
  receiveStock,
  transferStock,
} from '@/server/services/receiving.service'
import {
  createVehicle,
  moveTruckStock,
  suggestLoad,
} from '@/server/services/truckload.service'
import { addMember, balanceOf, createProduct, createTestOrg, type TestOrg } from '../helpers'

/** Warehouse and truck operations, all posting through the one ledger. */
describe('inventory operations', () => {
  let org: TestOrg
  let warehouse: string
  let product: Awaited<ReturnType<typeof createProduct>>
  let supplierId: string

  beforeEach(async () => {
    org = await createTestOrg()
    warehouse = org.warehouseLocationId
    product = await createProduct(org.organizationId, { unitsPerCase: 12 })
    const supplier = await db(org.ownerCtx).supplier.create({
      data: { organizationId: org.organizationId, name: 'Barcel USA' },
      select: { id: true },
    })
    supplierId = supplier.id
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  const receive = (cases: number, unitCost = '14.40') =>
    receiveStock(org.ownerCtx, {
      supplierId,
      warehouseLocationId: warehouse,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: cases, unitCost }],
    })

  describe('receiving', () => {
    it('raises the warehouse balance and records the shipment', async () => {
      const result = await receive(10)
      expect(result.replayed).toBe(false)
      expect(result.reference).toMatch(/^RCV-/)
      expect(await balanceOf(warehouse, product.id)).toBe(120)

      const receiving = await db(org.ownerCtx).receiving.findFirst({ include: { items: true } })
      expect(receiving?.items[0]).toMatchObject({ quantity: 10, baseQuantity: 120 })
    })

    it('divides the invoiced case cost into a per-base-unit cost', async () => {
      await receive(10, '14.40')
      const balance = await db(org.ownerCtx).inventoryBalance.findFirst({
        where: { locationId: warehouse, productId: product.id },
      })
      expect(balance?.avgUnitCost.toString()).toBe('1.2')
    })

    it('bills a retried submission once', async () => {
      const key = randomUUID()
      const input = {
        supplierId,
        warehouseLocationId: warehouse,
        idempotencyKey: key,
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 10, unitCost: '14.40' }],
      }

      const first = await receiveStock(org.ownerCtx, input)
      const second = await receiveStock(org.ownerCtx, input)

      expect(first.replayed).toBe(false)
      expect(second.replayed).toBe(true)
      expect(second.id).toBe(first.id)
      // The retry must not have brought in a second shipment.
      expect(await balanceOf(warehouse, product.id)).toBe(120)
    })

    it('refuses a UoM that belongs to another product', async () => {
      const other = await createProduct(org.organizationId, { sku: `OTHER-${Date.now()}` })
      await expect(
        receiveStock(org.ownerCtx, {
          warehouseLocationId: warehouse,
          idempotencyKey: randomUUID(),
          lines: [
            { productId: product.id, productUomId: other.caseUomId, quantity: 1, unitCost: '1' },
          ],
        }),
      ).rejects.toThrow(/does not belong to/i)
    })

    it('refuses to receive into a truck', async () => {
      const vehicle = await createVehicle(org.ownerCtx, {
        name: 'Truck #2', truckNumber: '2', active: true,
      })
      const truck = await db(org.ownerCtx).vehicle.findFirst({ where: { id: vehicle.id } })

      await expect(
        receiveStock(org.ownerCtx, {
          warehouseLocationId: truck!.locationId,
          idempotencyKey: randomUUID(),
          lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 1, unitCost: '1' }],
        }),
      ).rejects.toThrow(/is a truck, not a warehouse/i)
    })

    it('requires the permission, not merely a login', async () => {
      const office = await addMember(org, 'office')
      await expect(
        receiveStock(office.ctx, {
          warehouseLocationId: warehouse,
          idempotencyKey: randomUUID(),
          lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 1, unitCost: '1' }],
        }),
      ).rejects.toThrow(/permission/i)
    })
  })

  describe('adjustments', () => {
    it('writes off damage as a negative movement', async () => {
      await receive(10)
      await adjustStock(org.ownerCtx, {
        locationId: warehouse,
        type: 'DAMAGE',
        notes: 'Pallet dropped on the dock',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 2 }],
      })
      expect(await balanceOf(warehouse, product.id)).toBe(96)
    })

    it('treats a positive damage figure as a loss, not a gain', async () => {
      await receive(10)
      // Whoever types "2 cases damaged" means two fewer, whatever the sign.
      await adjustStock(org.ownerCtx, {
        locationId: warehouse,
        type: 'EXPIRED',
        notes: 'Past best-by',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 2 }],
      })
      expect(await balanceOf(warehouse, product.id)).toBe(96)
    })

    it('sets the balance to what was counted, up or down', async () => {
      await receive(10) // 120

      await adjustStock(org.ownerCtx, {
        locationId: warehouse,
        type: 'COUNT_ADJUSTMENT',
        notes: 'Monthly count',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.baseUomId, quantity: 103 }],
      })
      expect(await balanceOf(warehouse, product.id)).toBe(103)

      await adjustStock(org.ownerCtx, {
        locationId: warehouse,
        type: 'COUNT_ADJUSTMENT',
        notes: 'Recount after finding a pallet',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.baseUomId, quantity: 150 }],
      })
      expect(await balanceOf(warehouse, product.id)).toBe(150)
    })

    it('says so rather than posting an empty transaction when a count matches', async () => {
      await receive(10)
      await expect(
        adjustStock(org.ownerCtx, {
          locationId: warehouse,
          type: 'COUNT_ADJUSTMENT',
          notes: 'Count',
          idempotencyKey: randomUUID(),
          lines: [{ productId: product.id, productUomId: product.baseUomId, quantity: 120 }],
        }),
      ).rejects.toThrow(/already match/i)
    })

    it('will not write off more than is there', async () => {
      await receive(1)
      await expect(
        adjustStock(org.ownerCtx, {
          locationId: warehouse,
          type: 'DAMAGE',
          notes: 'Too much',
          idempotencyKey: randomUUID(),
          lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 5 }],
        }),
      ).rejects.toThrow(/Not enough stock/i)
    })

    it('records who, why and how much', async () => {
      await receive(10)
      await adjustStock(org.ownerCtx, {
        locationId: warehouse,
        type: 'MISSING',
        notes: 'Two cases unaccounted for after the count',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 2 }],
      })

      const entry = await db(org.ownerCtx).auditLog.findFirst({
        where: { action: 'inventory.missing' },
      })
      expect(entry?.userId).toBe(org.ownerUserId)
      expect((entry!.afterJson as Record<string, unknown>).notes).toMatch(/unaccounted/)
    })
  })

  describe('transfers', () => {
    it('moves stock between warehouses without creating any', async () => {
      await receive(10)
      const second = await db(org.ownerCtx).inventoryLocation.create({
        data: { organizationId: org.organizationId, kind: 'WAREHOUSE', name: 'Overflow' },
        select: { id: true },
      })

      await transferStock(org.ownerCtx, {
        fromLocationId: warehouse,
        toLocationId: second.id,
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 4 }],
      })

      expect(await balanceOf(warehouse, product.id)).toBe(72)
      expect(await balanceOf(second.id, product.id)).toBe(48)
      expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
    })

    it('refuses a transfer to the same place', async () => {
      await expect(
        transferStock(org.ownerCtx, {
          fromLocationId: warehouse,
          toLocationId: warehouse,
          idempotencyKey: randomUUID(),
          lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 1 }],
        }),
      ).rejects.toThrow(/two different locations/i)
    })
  })

  describe('truck load and unload', () => {
    let vehicleId: string
    let truckLocation: string

    beforeEach(async () => {
      const created = await createVehicle(org.ownerCtx, {
        name: 'Truck #2', truckNumber: '2', active: true,
      })
      vehicleId = created.id
      const vehicle = await db(org.ownerCtx).vehicle.findFirst({ where: { id: vehicleId } })
      truckLocation = vehicle!.locationId
    })

    it('gives a new truck its own stock location', async () => {
      const location = await db(org.ownerCtx).inventoryLocation.findFirst({
        where: { id: truckLocation },
      })
      expect(location?.kind).toBe('VEHICLE')
      expect(location?.name).toBe('Truck #2')
    })

    it('moves stock from the warehouse onto the truck', async () => {
      await receive(20)
      await moveTruckStock(org.ownerCtx, {
        vehicleId,
        warehouseLocationId: warehouse,
        direction: 'LOAD',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 15 }],
      })

      expect(await balanceOf(warehouse, product.id)).toBe(60)
      expect(await balanceOf(truckLocation, product.id)).toBe(180)
    })

    it('carries the warehouse cost onto the truck', async () => {
      await receive(20, '14.40')
      await moveTruckStock(org.ownerCtx, {
        vehicleId,
        warehouseLocationId: warehouse,
        direction: 'LOAD',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 15 }],
      })

      const truckBalance = await db(org.ownerCtx).inventoryBalance.findFirst({
        where: { locationId: truckLocation, productId: product.id },
      })
      expect(truckBalance?.avgUnitCost.toString()).toBe('1.2')
    })

    it('brings the remainder back at the end of the day', async () => {
      await receive(20)
      await moveTruckStock(org.ownerCtx, {
        vehicleId, warehouseLocationId: warehouse, direction: 'LOAD',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 15 }],
      })
      await moveTruckStock(org.ownerCtx, {
        vehicleId, warehouseLocationId: warehouse, direction: 'UNLOAD',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 11 }],
      })

      expect(await balanceOf(truckLocation, product.id)).toBe(48)
      expect(await balanceOf(warehouse, product.id)).toBe(192)
      expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
    })

    it('will not load more than the warehouse holds', async () => {
      await receive(5)
      await expect(
        moveTruckStock(org.ownerCtx, {
          vehicleId, warehouseLocationId: warehouse, direction: 'LOAD',
          idempotencyKey: randomUUID(),
          lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 15 }],
        }),
      ).rejects.toThrow(/Not enough stock/i)
      expect(await balanceOf(truckLocation, product.id)).toBe(0)
    })

    it('loads once when a submission is retried', async () => {
      await receive(20)
      const input = {
        vehicleId, warehouseLocationId: warehouse, direction: 'LOAD' as const,
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 15 }],
      }
      await moveTruckStock(org.ownerCtx, input)
      const second = await moveTruckStock(org.ownerCtx, input)

      expect(second.replayed).toBe(true)
      expect(await balanceOf(truckLocation, product.id)).toBe(180)
    })

    it('keeps a runner out of the warehouse loading screen', async () => {
      const runner = await addMember(org, 'runner')
      await expect(
        moveTruckStock(runner.ctx, {
          vehicleId, warehouseLocationId: warehouse, direction: 'LOAD',
          idempotencyKey: randomUUID(),
          lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 1 }],
        }),
      ).rejects.toThrow(/permission/i)
    })

    it('suggests nothing when there is no sales history to learn from', async () => {
      await receive(20)
      expect(
        await suggestLoad(org.ownerCtx, { vehicleId, warehouseLocationId: warehouse }),
      ).toEqual([])
    })
  })

  describe('history', () => {
    it('shows every movement for a product, newest first', async () => {
      await receive(10)
      await adjustStock(org.ownerCtx, {
        locationId: warehouse, type: 'DAMAGE', notes: 'Crushed',
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 1 }],
      })

      const ledger = await listLedger(org.ownerCtx, { productId: product.id })
      expect(ledger).toHaveLength(2)
      expect(ledger[0].type).toBe('DAMAGE')
      expect(ledger[0].quantityDelta).toBe(-12)
      expect(ledger[0].balanceAfter).toBe(108)
      expect(ledger[1].type).toBe('SUPPLIER_RECEIPT')
    })

    it('lists what is on hand at a location with its value', async () => {
      await receive(10, '14.40')
      const stock = await getLocationStock(org.ownerCtx, warehouse)
      expect(stock).toHaveLength(1)
      expect(stock[0]).toMatchObject({ quantity: 120, unitsPerCase: 12 })
      expect(stock[0].value).toBe('144.00')
    })
  })
})
