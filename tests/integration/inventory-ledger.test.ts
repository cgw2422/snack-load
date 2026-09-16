import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import {
  findBalanceDrift,
  InsufficientStockError,
  nextDocumentNumber,
  postInventoryTransaction,
} from '@/server/services/inventory.service'
import {
  avgCostOf,
  balanceOf,
  createProduct,
  createTestOrg,
  createVehicleLocation,
  type TestOrg,
} from '../helpers'

/**
 * The ledger is the only thing standing between a distributor and an inventory
 * number nobody can explain. Every rule in docs/02 §L is exercised here.
 */
describe('inventory ledger', () => {
  let org: TestOrg
  let warehouse: string
  let truck: string
  let product: Awaited<ReturnType<typeof createProduct>>
  const created: string[] = []

  beforeEach(async () => {
    org = await createTestOrg()
    created.push(org.organizationId)
    warehouse = org.warehouseLocationId
    truck = (await createVehicleLocation(org.organizationId)).locationId
    product = await createProduct(org.organizationId, { unitsPerCase: 12 })
  })

  afterAll(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: { in: created } } })
  })

  const receive = (quantity: number, unitCost = '1.200000') =>
    unsafeDb.$transaction((tx) =>
      postInventoryTransaction(tx, org.organizationId, {
        type: 'SUPPLIER_RECEIPT',
        lines: [{ productId: product.id, locationId: warehouse, quantityDelta: quantity, unitCost }],
      }),
    )

  it('records a supplier receipt and moves the balance', async () => {
    await receive(1200)
    expect(await balanceOf(warehouse, product.id)).toBe(1200)
  })

  it('keeps partial cases rather than rounding to whole ones', async () => {
    await receive(223) // 18 cases + 7 bags
    expect(await balanceOf(warehouse, product.id)).toBe(223)
  })

  it('moves stock to a truck without creating any', async () => {
    await receive(1200)

    await unsafeDb.$transaction((tx) =>
      postInventoryTransaction(tx, org.organizationId, {
        type: 'TRUCK_LOAD',
        lines: [
          { productId: product.id, locationId: warehouse, quantityDelta: -180 },
          { productId: product.id, locationId: truck, quantityDelta: 180 },
        ],
      }),
    )

    expect(await balanceOf(warehouse, product.id)).toBe(1020)
    expect(await balanceOf(truck, product.id)).toBe(180)
  })

  it('refuses a transfer whose lines do not net to zero', async () => {
    await receive(1200)

    await expect(
      unsafeDb.$transaction((tx) =>
        postInventoryTransaction(tx, org.organizationId, {
          type: 'TRUCK_LOAD',
          lines: [
            { productId: product.id, locationId: warehouse, quantityDelta: -180 },
            { productId: product.id, locationId: truck, quantityDelta: 240 },
          ],
        }),
      ),
    ).rejects.toThrow(/move stock, not create it/i)

    expect(await balanceOf(truck, product.id)).toBe(0)
  })

  it('carries cost from the source location to the destination', async () => {
    // Without this a freshly loaded truck averages against zero and reports its
    // inventory as worthless.
    await receive(1200, '1.250000')

    await unsafeDb.$transaction((tx) =>
      postInventoryTransaction(tx, org.organizationId, {
        type: 'TRUCK_LOAD',
        lines: [
          { productId: product.id, locationId: warehouse, quantityDelta: -180 },
          { productId: product.id, locationId: truck, quantityDelta: 180 },
        ],
      }),
    )

    expect(await avgCostOf(truck, product.id)).toBe('1.25')
  })

  it('will not let a sale drive a location negative', async () => {
    await receive(100)

    await expect(
      unsafeDb.$transaction((tx) =>
        postInventoryTransaction(tx, org.organizationId, {
          type: 'SALE',
          lines: [{ productId: product.id, locationId: warehouse, quantityDelta: -120 }],
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError)

    expect(await balanceOf(warehouse, product.id)).toBe(100)
  })

  it('names the shortfall so the runner knows what is missing', async () => {
    await receive(100)
    try {
      await unsafeDb.$transaction((tx) =>
        postInventoryTransaction(tx, org.organizationId, {
          type: 'SALE',
          lines: [{ productId: product.id, locationId: warehouse, quantityDelta: -120 }],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (error) {
      const e = error as InsufficientStockError
      expect(e.code).toBe('INSUFFICIENT_STOCK')
      expect(e.requested).toBe(120)
      expect(e.available).toBe(100)
      expect(e.productId).toBe(product.id)
    }
  })

  it('allows a count adjustment to set any value', async () => {
    await receive(100)
    await unsafeDb.$transaction((tx) =>
      postInventoryTransaction(tx, org.organizationId, {
        type: 'COUNT_ADJUSTMENT',
        allowNegative: true,
        lines: [{ productId: product.id, locationId: warehouse, quantityDelta: -140 }],
      }),
    )
    expect(await balanceOf(warehouse, product.id)).toBe(-40)
  })

  it('does not post any line when one line fails', async () => {
    await receive(100)
    const other = await createProduct(org.organizationId, { sku: `OTHER-${Date.now()}` })

    await expect(
      unsafeDb.$transaction((tx) =>
        postInventoryTransaction(tx, org.organizationId, {
          type: 'SALE',
          lines: [
            { productId: other.id, locationId: warehouse, quantityDelta: -1 },
            { productId: product.id, locationId: warehouse, quantityDelta: -120 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError)

    expect(await balanceOf(warehouse, other.id)).toBe(0)
    expect(await balanceOf(warehouse, product.id)).toBe(100)
  })

  it('weights the cost of incoming stock into a moving average', async () => {
    await receive(100, '1.000000')
    await receive(100, '2.000000')
    // (100 × 1.00 + 100 × 2.00) / 200 = 1.50
    expect(await avgCostOf(warehouse, product.id)).toBe('1.5')
  })

  it('leaves the average untouched when stock goes out', async () => {
    await receive(200, '1.500000')
    await unsafeDb.$transaction((tx) =>
      postInventoryTransaction(tx, org.organizationId, {
        type: 'SALE',
        lines: [{ productId: product.id, locationId: warehouse, quantityDelta: -50 }],
      }),
    )
    expect(await avgCostOf(warehouse, product.id)).toBe('1.5')
  })

  it('stamps each line with the balance it produced', async () => {
    await receive(100)
    await receive(50)

    const lines = await unsafeDb.inventoryTransactionLine.findMany({
      where: { organizationId: org.organizationId, productId: product.id },
      orderBy: { balanceAfter: 'asc' },
      select: { quantityDelta: true, balanceAfter: true },
    })
    expect(lines.map((l) => l.balanceAfter)).toEqual([100, 150])
  })

  it('rejects a fractional quantity outright', async () => {
    await expect(
      unsafeDb.$transaction((tx) =>
        postInventoryTransaction(tx, org.organizationId, {
          type: 'SUPPLIER_RECEIPT',
          lines: [{ productId: product.id, locationId: warehouse, quantityDelta: 1.5 }],
        }),
      ),
    ).rejects.toThrow(/whole number of base units/i)
  })

  it('rejects a line that moves nothing', async () => {
    await expect(
      unsafeDb.$transaction((tx) =>
        postInventoryTransaction(tx, org.organizationId, {
          type: 'SUPPLIER_RECEIPT',
          lines: [{ productId: product.id, locationId: warehouse, quantityDelta: 0 }],
        }),
      ),
    ).rejects.toThrow(/cannot move zero/i)
  })

  it('keeps the balance cache equal to the ledger after a full cycle', async () => {
    await receive(1200)
    await unsafeDb.$transaction((tx) =>
      postInventoryTransaction(tx, org.organizationId, {
        type: 'TRUCK_LOAD',
        lines: [
          { productId: product.id, locationId: warehouse, quantityDelta: -240 },
          { productId: product.id, locationId: truck, quantityDelta: 240 },
        ],
      }),
    )
    await unsafeDb.$transaction((tx) =>
      postInventoryTransaction(tx, org.organizationId, {
        type: 'SALE',
        lines: [{ productId: product.id, locationId: truck, quantityDelta: -36 }],
      }),
    )
    await unsafeDb.$transaction((tx) =>
      postInventoryTransaction(tx, org.organizationId, {
        type: 'DAMAGE',
        lines: [{ productId: product.id, locationId: truck, quantityDelta: -12 }],
      }),
    )
    await unsafeDb.$transaction((tx) =>
      postInventoryTransaction(tx, org.organizationId, {
        type: 'CUSTOMER_RETURN',
        lines: [{ productId: product.id, locationId: truck, quantityDelta: 6 }],
      }),
    )

    expect(await balanceOf(warehouse, product.id)).toBe(960)
    expect(await balanceOf(truck, product.id)).toBe(198) // 240 − 36 − 12 + 6
    expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
  })

  it('survives concurrent postings against the same product without losing units', async () => {
    await receive(1200)

    // Twelve simultaneous sales of one case each. Row locking has to serialise
    // them; a read-modify-write would lose updates here.
    await Promise.all(
      Array.from({ length: 12 }, () =>
        unsafeDb.$transaction((tx) =>
          postInventoryTransaction(tx, org.organizationId, {
            type: 'SALE',
            lines: [{ productId: product.id, locationId: warehouse, quantityDelta: -12 }],
          }),
        ),
      ),
    )

    expect(await balanceOf(warehouse, product.id)).toBe(1200 - 144)
    expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
  })

  it('never hands out the same document number twice', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 15 }, () =>
        unsafeDb.$transaction((tx) => nextDocumentNumber(tx, org.organizationId, 'SALE')),
      ),
    )
    expect(new Set(numbers).size).toBe(15)
    expect(numbers.every((n) => n.startsWith('S-'))).toBe(true)
  })

  it('pads document numbers to a stable width', async () => {
    const number = await unsafeDb.$transaction((tx) =>
      nextDocumentNumber(tx, org.organizationId, 'RECEIPT'),
    )
    expect(number).toBe('R-10001')
  })
})
