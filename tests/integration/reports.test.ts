import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout, voidSale } from '@/server/services/sale.service'
import { recordPayment } from '@/server/services/payment.service'
import { runReport, type ReportRow } from '@/server/reports'
import { toCsv, toPdf, toXlsx } from '@/server/reports/export'
import {
  addMember,
  createCustomer,
  createProduct,
  createTestOrg,
  type TestOrg,
} from '../helpers'

/** Yesterday and today as calendar days, which is what the filters take. */
function day(offset = 0): string {
  return new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
}

const WINDOW = { from: day(7), to: day(-1) }

function rowFor(rows: ReportRow[], label: string) {
  return rows.find((r) => r.label === label)
}

/**
 * Reporting (spec §29–§34).
 *
 * The tests that matter here are the ones that pin a report to the
 * transactions underneath it: revenue equals the sum of the sales, gross profit
 * equals revenue minus the costs frozen on the lines, aging equals the invoices'
 * own balances. A report that agrees with itself but not with the ledger is the
 * failure mode this phase exists to avoid.
 */
describe('reports', () => {
  let org: TestOrg
  let runner: Awaited<ReturnType<typeof addMember>>
  let customerId: string
  let secondCustomerId: string
  let product: Awaited<ReturnType<typeof createProduct>>

  beforeEach(async () => {
    org = await createTestOrg()
    runner = await addMember(org, 'runner', { firstName: 'Mike', lastName: 'Donnelly' })

    customerId = (await createCustomer(org.organizationId)).id
    secondCustomerId = (await createCustomer(org.organizationId, 'Corner Market')).id

    product = await createProduct(org.organizationId, {
      name: 'Takis Fuego',
      unitsPerCase: 12,
      casePrice: '19.50',
      unitPrice: '2.29',
      costPerBaseUnit: '1.200000',
    })

    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [
        { productId: product.id, productUomId: product.caseUomId, quantity: 60, unitCost: '14.40' },
      ],
    })

    const vehicle = await createVehicle(org.ownerCtx, {
      name: 'Truck #2', truckNumber: '2', active: true, assignedUserId: runner.userId,
    })
    await db(org.ownerCtx).membership.updateMany({
      where: { userId: runner.userId },
      data: { defaultVehicleId: vehicle.id },
    })
    await moveTruckStock(org.ownerCtx, {
      vehicleId: vehicle.id,
      warehouseLocationId: org.warehouseLocationId,
      direction: 'LOAD',
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 40 }],
    })
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  async function sell(customer: string, cases: number, paid?: string) {
    return checkout(runner.ctx, {
      customerId: customer,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: cases }],
      ...(paid ? { payment: { method: 'CASH' as const, amount: paid } } : {}),
    })
  }

  describe('sales', () => {
    it('totals exactly what was posted', async () => {
      await sell(customerId, 2)
      await sell(customerId, 3)
      await sell(secondCustomerId, 1)

      const report = await runReport(org.ownerCtx, 'sales', { ...WINDOW, groupBy: 'customer' })

      // 6 cases at $19.50.
      expect(report.totals?.gross).toBe('117.00')
      expect(report.totals?.orders).toBe(3)
      expect(report.totals?.units).toBe(72)

      expect(rowFor(report.rows, "Joe's Marathon")).toMatchObject({
        orders: 2, gross: '97.50', units: 60,
      })
      expect(rowFor(report.rows, 'Corner Market')).toMatchObject({ orders: 1, gross: '19.50' })
    })

    it('leaves a voided sale out entirely rather than netting it off', async () => {
      const kept = await sell(customerId, 2)
      const scrapped = await sell(customerId, 3)
      await voidSale(org.ownerCtx, scrapped.saleId, 'Wrong store')

      const report = await runReport(org.ownerCtx, 'sales', { ...WINDOW, groupBy: 'customer' })

      expect(report.totals?.gross).toBe('39.00')
      expect(report.totals?.orders).toBe(1)
      expect(kept.saleId).toBeTruthy()
    })

    it('regroups the same money without changing the total', async () => {
      await sell(customerId, 2)
      await sell(secondCustomerId, 4)

      const byCustomer = await runReport(org.ownerCtx, 'sales', { ...WINDOW, groupBy: 'customer' })
      const byProduct = await runReport(org.ownerCtx, 'sales', { ...WINDOW, groupBy: 'product' })
      const byDay = await runReport(org.ownerCtx, 'sales', { ...WINDOW, groupBy: 'day' })

      expect(byProduct.totals?.gross).toBe(byCustomer.totals?.gross)
      expect(byDay.totals?.gross).toBe(byCustomer.totals?.gross)
    })

    it('ranks by amount, not by how the amount reads as text', async () => {
      // 1 case is $19.50 and 9 cases are $175.50. Sorted as strings, "19.50"
      // comes after "175.50" — which is exactly how a money column cast to
      // ::text sorts if the query orders by its ordinal.
      await sell(customerId, 1)
      await sell(secondCustomerId, 9)

      const report = await runReport(org.ownerCtx, 'sales', { ...WINDOW, groupBy: 'customer' })

      expect(report.rows.map((r) => r.label)).toEqual(['Corner Market', "Joe's Marathon"])
      expect(report.rows.map((r) => r.gross)).toEqual(['175.50', '19.50'])
    })

    it('narrows to one store when asked', async () => {
      await sell(customerId, 2)
      await sell(secondCustomerId, 4)

      const report = await runReport(org.ownerCtx, 'sales', { ...WINDOW, customerId })
      expect(report.totals?.gross).toBe('39.00')
      expect(report.appliedTo).toContain("Joe's Marathon")
    })

    it('excludes a window that does not contain the sale', async () => {
      await sell(customerId, 2)
      const report = await runReport(org.ownerCtx, 'sales', { from: day(30), to: day(20) })
      expect(report.totals?.gross).toBe('0.00')
      expect(report.rows).toHaveLength(0)
    })
  })

  describe('gross profit', () => {
    it('is net sales less the cost frozen on the line', async () => {
      await sell(customerId, 5)

      const report = await runReport(org.ownerCtx, 'gross-profit', { ...WINDOW })

      // 5 cases × $19.50 = $97.50 of merchandise.
      // 60 base units × $1.20 landed cost = $72.00 of COGS.
      expect(report.totals?.netSales).toBe('97.50')
      expect(report.totals?.cogs).toBe('72.00')
      expect(report.totals?.grossProfit).toBe('25.50')
      expect(report.totals?.margin).toBe('26.15')
    })

    it('does not restate a closed sale when the cost changes afterwards', async () => {
      await sell(customerId, 5)
      const before = await runReport(org.ownerCtx, 'gross-profit', { ...WINDOW })

      // The next delivery costs far more.
      await receiveStock(org.ownerCtx, {
        warehouseLocationId: org.warehouseLocationId,
        idempotencyKey: randomUUID(),
        lines: [
          { productId: product.id, productUomId: product.caseUomId, quantity: 20, unitCost: '30.00' },
        ],
      })

      const after = await runReport(org.ownerCtx, 'gross-profit', { ...WINDOW })
      expect(after.totals?.cogs).toBe(before.totals?.cogs)
      expect(after.totals?.grossProfit).toBe(before.totals?.grossProfit)
    })

    it('says plainly that it is gross, not net', async () => {
      const report = await runReport(org.ownerCtx, 'gross-profit', { ...WINDOW })
      expect(report.definition).toMatch(/GROSS profit, not net/)
      expect(report.definition).toMatch(/no fuel, wages/)
      expect(report.notes.join(' ')).toMatch(/not net profit/)
    })

    it('is refused to someone without the financial permission', async () => {
      const warehouse = await addMember(org, 'warehouse')
      await expect(runReport(warehouse.ctx, 'gross-profit', { ...WINDOW })).rejects.toThrow()
      // …while the volume report stays open to them.
      await expect(runReport(warehouse.ctx, 'sales', { ...WINDOW })).resolves.toBeTruthy()
    })
  })

  describe('customers', () => {
    it('compares a store with its own prior window, not with other stores', async () => {
      // Prior window: a sale placed squarely inside it. Ten days rather than
      // fourteen because the prior window is the seven days before `from`, and
      // fourteen lands within a few hours of its far edge — near enough that
      // the organization's UTC offset decides whether it counts.
      const older = await sell(customerId, 8)
      await db(org.ownerCtx).sale.update({
        where: { id: older.saleId },
        data: { occurredAt: new Date(Date.now() - 10 * 86_400_000) },
      })
      // Current window: much smaller.
      await sell(customerId, 2)

      const report = await runReport(org.ownerCtx, 'customers', { from: day(6), to: day(-1) })
      const row = rowFor(report.rows, "Joe's Marathon")

      expect(row?.revenue).toBe('39.00')
      expect(row?.priorRevenue).toBe('156.00')
      expect(row?.change).toBe('-75.00')
      expect(row?.status).toBe('Declining')
    })

    it('calls a store that stopped ordering stopped, not down 100%', async () => {
      const older = await sell(customerId, 4)
      await db(org.ownerCtx).sale.update({
        where: { id: older.saleId },
        data: { occurredAt: new Date(Date.now() - 12 * 86_400_000) },
      })

      const report = await runReport(org.ownerCtx, 'customers', { from: day(6), to: day(-1) })
      expect(rowFor(report.rows, "Joe's Marathon")?.status).toBe('Stopped')
    })

    it('gives a brand-new account no percentage rather than an infinite one', async () => {
      await sell(customerId, 2)
      const report = await runReport(org.ownerCtx, 'customers', { ...WINDOW })
      const row = rowFor(report.rows, "Joe's Marathon")

      expect(row?.change).toBeNull()
      expect(row?.status).toBe('New')
    })
  })

  describe('inventory', () => {
    it('values on-hand at cost and reports what moved', async () => {
      await sell(customerId, 5)

      const report = await runReport(org.ownerCtx, 'inventory', { ...WINDOW })
      const row = rowFor(report.rows, 'Takis Fuego')

      // 60 cases received, 5 sold: 55 cases = 660 base units at $1.20.
      expect(row?.onHand).toBe(660)
      expect(row?.value).toBe('792.00')
      expect(row?.sold).toBe(60)
      expect(row?.received).toBe(720)
    })

    it('warns when a balance no longer matches the ledger', async () => {
      const clean = await runReport(org.ownerCtx, 'inventory', { ...WINDOW })
      expect(clean.notes.some((n) => n.includes('do not match'))).toBe(false)

      // Corrupt the cache behind the ledger's back — exactly what the check is for.
      await unsafeDb.$executeRawUnsafe(
        `UPDATE inventory_balance SET quantity = quantity + 5 WHERE organization_id = $1`,
        org.organizationId,
      )

      const dirty = await runReport(org.ownerCtx, 'inventory', { ...WINDOW })
      expect(dirty.notes[0]).toMatch(/do not match the ledger|does not match the ledger/)
    })
  })

  describe('routes and runners', () => {
    it('separates what was billed from what was collected', async () => {
      await sell(customerId, 4, '20.00')
      await sell(secondCustomerId, 2)

      const report = await runReport(org.ownerCtx, 'runners', { ...WINDOW })
      // No route was run in this test, so there is nothing to attribute.
      expect(report.rows).toHaveLength(0)
      expect(report.definition).toMatch(/Billed is the/)
      expect(report.notes.join(' ')).toMatch(/Billed is not collected/)
    })
  })

  describe('aging', () => {
    it('buckets from the due date, so terms are respected', async () => {
      const cod = await sell(customerId, 2)
      const net30 = await sell(secondCustomerId, 2)

      // Both written 20 days ago. One was due on the day, one is due in 10 more.
      const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000)
      await db(org.ownerCtx).sale.update({
        where: { id: cod.saleId },
        data: { occurredAt: twentyDaysAgo, dueDate: twentyDaysAgo },
      })
      await db(org.ownerCtx).sale.update({
        where: { id: net30.saleId },
        data: {
          occurredAt: twentyDaysAgo,
          dueDate: new Date(Date.now() + 10 * 86_400_000),
        },
      })

      const report = await runReport(org.ownerCtx, 'aging', { ...WINDOW })

      expect(rowFor(report.rows, "Joe's Marathon")?.d1to30).toBe('39.00')
      expect(rowFor(report.rows, "Joe's Marathon")?.current).toBe('0.00')
      expect(rowFor(report.rows, 'Corner Market')?.current).toBe('39.00')
      expect(rowFor(report.rows, 'Corner Market')?.d1to30).toBe('0.00')
      expect(report.totals?.total).toBe('78.00')
    })

    it('puts the biggest debtor at the top, whatever the digits look like', async () => {
      await sell(customerId, 1)
      await sell(secondCustomerId, 9)

      const report = await runReport(org.ownerCtx, 'aging', { ...WINDOW })
      expect(report.rows.map((r) => r.label)).toEqual(['Corner Market', "Joe's Marathon"])
    })

    it('agrees with the invoices it is built from', async () => {
      await sell(customerId, 3, '10.00')
      await sell(secondCustomerId, 2)

      const report = await runReport(org.ownerCtx, 'aging', { ...WINDOW })
      const invoices = await db(org.ownerCtx).sale.aggregate({
        where: { status: 'COMPLETED', balanceDue: { gt: 0 } },
        _sum: { balanceDue: true },
      })

      expect(report.totals?.total).toBe(Number(invoices._sum.balanceDue).toFixed(2))
    })

    it('shows credit on account separately instead of netting it off', async () => {
      await sell(customerId, 2)
      // Pay more than is owed; the surplus becomes credit.
      await recordPayment(org.ownerCtx, {
        customerId,
        method: 'CASH',
        amount: '60.00',
        strategy: 'OLDEST_FIRST',
        idempotencyKey: randomUUID(),
      })
      await sell(customerId, 2)

      const report = await runReport(org.ownerCtx, 'aging', { ...WINDOW })
      const row = rowFor(report.rows, "Joe's Marathon")

      expect(Number(row?.credit)).toBeGreaterThan(0)
      expect(row?.total).toBe('39.00')
    })

    it('drops a voided invoice out of the buckets', async () => {
      const sale = await sell(customerId, 3)
      const before = await runReport(org.ownerCtx, 'aging', { ...WINDOW })
      expect(before.totals?.total).toBe('58.50')

      await voidSale(org.ownerCtx, sale.saleId, 'Returned unopened')

      const after = await runReport(org.ownerCtx, 'aging', { ...WINDOW })
      expect(after.rows).toHaveLength(0)
    })
  })

  describe('exports', () => {
    it('carries the definition into every format', async () => {
      await sell(customerId, 3)
      const report = await runReport(org.ownerCtx, 'gross-profit', { ...WINDOW })

      const csv = toCsv(report)
      expect(csv).toContain('GROSS profit, not net')
      expect(csv).toContain('Gross profit')

      const xlsx = await toXlsx(report)
      expect(xlsx.byteLength).toBeGreaterThan(1000)

      const pdf = await toPdf(report)
      expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-')
    })

    it('defuses a cell that a spreadsheet would run as a formula', async () => {
      await db(org.ownerCtx).customer.update({
        where: { id: customerId },
        data: { name: '=HYPERLINK("http://evil.test","click")' },
      })
      await sell(customerId, 1)

      const report = await runReport(org.ownerCtx, 'sales', { ...WINDOW, groupBy: 'customer' })
      const csv = toCsv(report)

      expect(csv).toContain(`"'=HYPERLINK`)
      expect(csv).not.toMatch(/(^|,)=HYPERLINK/m)
    })

    it('does not fail a PDF over a character the built-in font cannot draw', async () => {
      // A store name pasted out of a spreadsheet, with a typographic dash, a
      // curly apostrophe and a character well outside Latin-1.
      await db(org.ownerCtx).customer.update({
        where: { id: customerId },
        data: { name: 'Ōtaki \u2014 Joe\u2019s Corner \u2212 Store' },
      })
      await sell(customerId, 2)

      const report = await runReport(org.ownerCtx, 'sales', { ...WINDOW, groupBy: 'customer' })
      const pdf = await toPdf(report)

      expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-')
      // CSV is UTF-8 and keeps the name exactly as entered.
      expect(toCsv(report)).toContain('Joe\u2019s Corner')
    })

    it('keeps money at two decimals rather than handing over a float', async () => {
      await sell(customerId, 3)
      const report = await runReport(org.ownerCtx, 'sales', { ...WINDOW, groupBy: 'customer' })

      for (const row of report.rows) {
        for (const key of ['gross', 'returns', 'net', 'tax']) {
          expect(String(row[key])).toMatch(/^-?\d+\.\d{2}$/)
        }
      }
    })
  })

  describe('tenant isolation', () => {
    it('never reports another company\'s sales', async () => {
      await sell(customerId, 4)

      const other = await createTestOrg()
      try {
        const report = await runReport(other.ownerCtx, 'sales', { ...WINDOW })
        expect(report.totals?.gross).toBe('0.00')
        expect(report.rows).toHaveLength(0)
      } finally {
        await unsafeDb.organization.deleteMany({ where: { id: other.organizationId } })
      }
    })
  })
})
