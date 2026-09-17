import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { findBalanceDrift } from '@/server/services/inventory.service'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout } from '@/server/services/sale.service'
import { createReturn, getReturnableLines } from '@/server/services/return.service'
import { getCreditPosition } from '@/server/services/credit.service'
import { m, toAmountString } from '@/server/domain/money'
import {
  addMember,
  balanceOf,
  createCustomer,
  createProduct,
  createTestOrg,
  type TestOrg,
} from '../helpers'

/**
 * Concurrent returns (hardening item 1 and item 3).
 *
 * Everything here launches genuinely competing operations — the calls are all
 * started before any of them is awaited, so they are inside their transactions
 * at the same time and the database is the only thing deciding the outcome.
 * Two sequential calls would pass against the old read-then-check code and
 * prove nothing.
 *
 * Every race is repeated. A concurrency test that runs once is a coin toss
 * dressed up as an assertion: the interleaving that breaks a guard is often the
 * rarer one, and a single green run would hide it.
 */

/** Enough repetitions to catch an interleaving that only sometimes happens. */
const ROUNDS = 12

describe('concurrent returns', () => {
  let org: TestOrg
  let runner: Awaited<ReturnType<typeof addMember>>
  let customerId: string
  let product: Awaited<ReturnType<typeof createProduct>>
  let second: Awaited<ReturnType<typeof createProduct>>
  let truckLocation: string

  beforeEach(async () => {
    org = await createTestOrg()
    runner = await addMember(org, 'runner', { firstName: 'Mike', lastName: 'Donnelly' })

    const taxRate = await db(org.ownerCtx).taxRate.create({
      data: { organizationId: org.organizationId, name: 'Ohio 7.25%', rate: '0.0725', isDefault: true },
      select: { id: true },
    })

    const customer = await createCustomer(org.organizationId)
    customerId = customer.id
    await db(org.ownerCtx).customer.update({
      where: { id: customerId },
      data: { taxRateId: taxRate.id },
    })

    product = await createProduct(org.organizationId, {
      name: 'Takis Fuego', unitsPerCase: 12, casePrice: '19.50', costPerBaseUnit: '1.200000',
    })
    second = await createProduct(org.organizationId, {
      name: 'Cheetos Flamin Hot', unitsPerCase: 12, casePrice: '17.25', costPerBaseUnit: '1.050000',
    })

    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [
        { productId: product.id, productUomId: product.caseUomId, quantity: 200, unitCost: '14.40' },
        { productId: second.id, productUomId: second.caseUomId, quantity: 200, unitCost: '12.60' },
      ],
    })

    const vehicle = await createVehicle(org.ownerCtx, {
      name: 'Truck #2', truckNumber: '2', active: true, assignedUserId: runner.userId,
    })
    truckLocation = (await db(org.ownerCtx).vehicle.findFirstOrThrow({ where: { id: vehicle.id } })).locationId

    await db(org.ownerCtx).membership.updateMany({
      where: { userId: runner.userId },
      data: { defaultVehicleId: vehicle.id },
    })
    await moveTruckStock(org.ownerCtx, {
      vehicleId: vehicle.id,
      warehouseLocationId: org.warehouseLocationId,
      direction: 'LOAD',
      idempotencyKey: randomUUID(),
      lines: [
        { productId: product.id, productUomId: product.caseUomId, quantity: 150 },
        { productId: second.id, productUomId: second.caseUomId, quantity: 150 },
      ],
    })
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  async function sell(cases: { product: typeof product; quantity: number }[]) {
    return checkout(runner.ctx, {
      customerId,
      idempotencyKey: randomUUID(),
      lines: cases.map((c) => ({
        productId: c.product.id,
        productUomId: c.product.caseUomId,
        quantity: c.quantity,
      })),
    })
  }

  async function saleItems(saleId: string) {
    return db(org.ownerCtx).saleItem.findMany({ where: { saleId }, orderBy: { sortOrder: 'asc' } })
  }

  /**
   * Starts every operation before awaiting any of them. `Promise.allSettled`
   * over already-started promises is the whole point: mapping them lazily and
   * awaiting one at a time would be the sequential test this is not.
   */
  async function race<T>(operations: Promise<T>[]) {
    const settled = await Promise.allSettled(operations)
    return {
      fulfilled: settled.filter(
        (result): result is PromiseFulfilledResult<Awaited<T>> => result.status === 'fulfilled',
      ),
      rejected: settled.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      ),
    }
  }

  function returnOneCase(saleId: string, saleItemId: string, quantity = 1) {
    return createReturn(runner.ctx, {
      saleId,
      reason: 'DAMAGED',
      lines: [{ saleItemId, quantity, disposition: 'RESTOCK_TRUCK' }],
      financialAction: 'ACCOUNT_CREDIT',
      idempotencyKey: randomUUID(),
    })
  }

  // ── item 1: the guard ─────────────────────────────────────────────────────

  it('lets exactly one of two simultaneous returns take the last case', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      // Sold 3, already returned 2, two concurrent requests for 1 case each.
      const sale = await sell([{ product, quantity: 3 }])
      const [item] = await saleItems(sale.saleId)

      await returnOneCase(sale.saleId, item.id, 2)

      const { fulfilled, rejected } = await race([
        returnOneCase(sale.saleId, item.id),
        returnOneCase(sale.saleId, item.id),
      ])

      expect(fulfilled, `round ${round}: exactly one return should win`).toHaveLength(1)
      expect(rejected).toHaveLength(1)

      // A clean domain error, not a constraint violation leaking out of the
      // driver and not a deadlock the runner has to interpret.
      const error = rejected[0].reason as { code?: string; message?: string }
      expect(error.code, `round ${round}: ${error.message}`).toBe('CONFLICT')
      expect(error.message).toMatch(/only 0 cases can still be returned from/i)

      // Net returned never exceeds what was sold.
      const returned = await db(org.ownerCtx).returnItem.aggregate({
        where: { saleItemId: item.id, return: { status: 'COMPLETED' } },
        _sum: { baseQuantity: true },
      })
      expect(returned._sum.baseQuantity).toBe(36)

      const view = await getReturnableLines(runner.ctx, sale.saleId)
      expect(view.lines[0].returnableQuantity).toBe(0)
    }
  })

  it('lets exactly one of six simultaneous returns take a one-case sale', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const sale = await sell([{ product, quantity: 1 }])
      const [item] = await saleItems(sale.saleId)

      const { fulfilled, rejected } = await race(
        Array.from({ length: 6 }, () => returnOneCase(sale.saleId, item.id)),
      )

      expect(fulfilled, `round ${round}`).toHaveLength(1)
      expect(rejected).toHaveLength(5)
      for (const failure of rejected) {
        expect((failure.reason as { code?: string }).code).toBe('CONFLICT')
      }

      const returned = await db(org.ownerCtx).returnItem.aggregate({
        where: { saleItemId: item.id, return: { status: 'COMPLETED' } },
        _sum: { baseQuantity: true },
      })
      expect(returned._sum.baseQuantity).toBe(12)
    }
  })

  it('admits concurrent returns that together fit inside what was sold', async () => {
    // The guard must not be a mutex on the sale line. Three runners taking one
    // case each out of five sold is legitimate and must all succeed.
    for (let round = 0; round < ROUNDS; round++) {
      const sale = await sell([{ product, quantity: 5 }])
      const [item] = await saleItems(sale.saleId)

      const { fulfilled, rejected } = await race([
        returnOneCase(sale.saleId, item.id),
        returnOneCase(sale.saleId, item.id),
        returnOneCase(sale.saleId, item.id),
      ])

      expect(rejected, `round ${round}: ${rejected.map((r) => String(r.reason)).join(' / ')}`).toHaveLength(0)
      expect(fulfilled).toHaveLength(3)

      const view = await getReturnableLines(runner.ctx, sale.saleId)
      expect(view.lines[0].returnableQuantity).toBe(2)
    }
  })

  it('does not deadlock when two returns touch the same two lines in opposite order', async () => {
    // Both transactions need both sale lines. Locking them in the order the
    // request happens to list them would let each hold what the other wants;
    // the lock is taken in id order precisely so one simply waits.
    for (let round = 0; round < ROUNDS; round++) {
      const sale = await sell([
        { product, quantity: 1 },
        { product: second, quantity: 1 },
      ])
      const items = await saleItems(sale.saleId)

      const lines = (order: typeof items) =>
        order.map((item) => ({ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' as const }))

      const { fulfilled, rejected } = await race([
        createReturn(runner.ctx, {
          saleId: sale.saleId, reason: 'DAMAGED', lines: lines(items),
          financialAction: 'ACCOUNT_CREDIT', idempotencyKey: randomUUID(),
        }),
        createReturn(runner.ctx, {
          saleId: sale.saleId, reason: 'DAMAGED', lines: lines([...items].reverse()),
          financialAction: 'ACCOUNT_CREDIT', idempotencyKey: randomUUID(),
        }),
      ])

      expect(fulfilled, `round ${round}`).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      // A deadlock would surface as Postgres 40P01, never as our own conflict.
      expect((rejected[0].reason as { code?: string }).code).toBe('CONFLICT')
    }
  })

  // ── item 3: reconciliation after the race ─────────────────────────────────

  describe('reconciliation after competing attempts', () => {
    it('leaves no trace of the attempts that lost', async () => {
      const sale = await sell([{ product, quantity: 4 }])
      const [item] = await saleItems(sale.saleId)
      const truckBefore = await balanceOf(truckLocation, product.id)

      // Four runners want two cases each; only two can be satisfied.
      const { fulfilled, rejected } = await race(
        Array.from({ length: 4 }, () => returnOneCase(sale.saleId, item.id, 2)),
      )
      expect(fulfilled).toHaveLength(2)
      expect(rejected).toHaveLength(2)

      const winners = fulfilled.map((f) => f.value)
      const prisma = db(org.ownerCtx)

      // 1. Original quantity − valid posted returns = remaining returnable.
      const view = await getReturnableLines(runner.ctx, sale.saleId)
      expect(view.lines[0].soldBaseQuantity).toBe(48)
      expect(view.lines[0].returnedBaseQuantity).toBe(48)
      expect(view.lines[0].returnableQuantity).toBe(0)

      // 2. One return document per winner, and no half-written one from a loser.
      const returns = await prisma.return.findMany({ where: { saleId: sale.saleId } })
      expect(returns).toHaveLength(2)
      expect(returns.map((r) => r.id).sort()).toEqual(winners.map((w) => w.returnId).sort())
      const returnItems = await prisma.returnItem.findMany({ where: { saleItemId: item.id } })
      expect(returnItems).toHaveLength(2)

      // Document numbers are consumed only by transactions that committed, so
      // a lost race leaves no gap in the sequence either.
      expect(returns.map((r) => r.returnNumber).sort()).toEqual(['RT-00001', 'RT-00002'])

      // 3. Inventory reconciles: two cases each came back to the truck, and the
      //    ledger still equals the balance cache.
      expect(await balanceOf(truckLocation, product.id)).toBe(truckBefore + 48)
      expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])

      // 4. No duplicate inventory transaction — one per committed return.
      const transactions = await prisma.inventoryTransaction.findMany({
        where: { referenceType: 'Return' },
        select: { id: true, referenceId: true },
      })
      expect(transactions).toHaveLength(2)
      expect(new Set(transactions.map((t) => t.referenceId)).size).toBe(2)

      // 5. No duplicate credit memo, and the memo totals equal the returns.
      const memos = await prisma.creditMemo.findMany({ where: { customerId } })
      expect(memos).toHaveLength(2)
      expect(memos.map((memo) => memo.saleId)).toEqual([sale.saleId, sale.saleId])
      const memoTotal = memos.reduce((total, memo) => total.plus(m(memo.amount)), m(0))
      const returnTotal = returns.reduce((total, row) => total.plus(m(row.total)), m(0))
      expect(toAmountString(memoTotal)).toBe(toAmountString(returnTotal))

      // Two winners at two cases each is the whole four-case sale, so the
      // credit equals the sale exactly — tax included, and never more.
      const saleRow = await prisma.sale.findUniqueOrThrow({ where: { id: sale.saleId } })
      expect(toAmountString(memoTotal)).toBe(toAmountString(saleRow.total))

      // 6. AR reconciles. The credit was left on the account, so the invoice is
      //    untouched and the credit shows as available (docs/02 §A2).
      const position = await getCreditPosition(org.ownerCtx, customerId)
      expect(position.openInvoices).toBe(toAmountString(saleRow.balanceDue))
      expect(position.memoCredit).toBe(toAmountString(memoTotal))
      expect(position.net).toBe(toAmountString(m(saleRow.balanceDue).minus(memoTotal)))

      // 7. Nothing partial survived: no orphan memo, no orphan ledger line.
      const orphanMemos = await prisma.creditMemo.count({
        where: { saleId: sale.saleId, return: { is: null } },
      })
      expect(orphanMemos).toBe(0)
      const lines = await prisma.inventoryTransactionLine.count({
        where: { transaction: { referenceType: 'Return' } },
      })
      expect(lines).toBe(2)
    })

    it('keeps the ledger reconciled across a long run of races', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const sale = await sell([{ product, quantity: 2 }])
        const [item] = await saleItems(sale.saleId)
        await race(Array.from({ length: 3 }, () => returnOneCase(sale.saleId, item.id, 2)))
      }

      expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])

      const prisma = db(org.ownerCtx)
      const returned = await prisma.returnItem.aggregate({
        where: { return: { status: 'COMPLETED' } },
        _sum: { baseQuantity: true },
      })
      // One winner per round, 2 cases each, and never more.
      expect(returned._sum.baseQuantity).toBe(ROUNDS * 24)
      expect(await prisma.return.count()).toBe(ROUNDS)
      expect(await prisma.creditMemo.count()).toBe(ROUNDS)
    })
  })
})
