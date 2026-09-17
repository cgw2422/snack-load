import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout } from '@/server/services/sale.service'
import { recordPayment } from '@/server/services/payment.service'
import { createReturn } from '@/server/services/return.service'
import { readTaxSnapshot } from '@/server/domain/taxSnapshot'
import {
  addMember,
  createCustomer,
  createProduct,
  createTestOrg,
  type TestOrg,
} from '../helpers'

/**
 * What a posted document remembers about tax, and what kind of document it is
 * (hardening items 5 and 6).
 *
 * Both exist for the same reason: Phase 8 has to represent a document in
 * somebody else's accounting system, possibly months later, and every fact it
 * needs must come off the document itself. Anything reconstructed from today's
 * customer settings is a figure that changes when a store registers for an
 * exemption, and an invoice that changes is not an invoice.
 */
describe('what a posted document remembers', () => {
  let org: TestOrg
  let runner: Awaited<ReturnType<typeof addMember>>
  let office: Awaited<ReturnType<typeof addMember>>
  let customerId: string
  let ohio: string
  let taxable: Awaited<ReturnType<typeof createProduct>>
  let exemptGoods: Awaited<ReturnType<typeof createProduct>>

  beforeEach(async () => {
    org = await createTestOrg()
    runner = await addMember(org, 'runner', { firstName: 'Mike', lastName: 'Donnelly' })
    office = await addMember(org, 'office', { firstName: 'Pat', lastName: 'Sandoval' })

    const rate = await db(org.ownerCtx).taxRate.create({
      data: {
        organizationId: org.organizationId,
        name: 'Ohio 7.25%',
        rate: '0.0725',
        code: 'OH-STATE',
        jurisdiction: 'Erie County, OH',
        isDefault: true,
      },
      select: { id: true },
    })
    ohio = rate.id

    const customer = await createCustomer(org.organizationId)
    customerId = customer.id
    await db(org.ownerCtx).customer.update({
      where: { id: customerId },
      data: { taxRateId: ohio },
    })

    taxable = await createProduct(org.organizationId, {
      name: 'Takis Fuego', unitsPerCase: 12, casePrice: '20.00', costPerBaseUnit: '1.200000',
      taxable: true,
    })
    exemptGoods = await createProduct(org.organizationId, {
      name: 'Bottled Water', unitsPerCase: 24, casePrice: '10.00', costPerBaseUnit: '0.300000',
      taxable: false,
    })

    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [
        { productId: taxable.id, productUomId: taxable.caseUomId, quantity: 60, unitCost: '14.40' },
        { productId: exemptGoods.id, productUomId: exemptGoods.caseUomId, quantity: 60, unitCost: '7.20' },
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
      lines: [
        { productId: taxable.id, productUomId: taxable.caseUomId, quantity: 40 },
        { productId: exemptGoods.id, productUomId: exemptGoods.caseUomId, quantity: 40 },
      ],
    })
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  async function sell(
    lines: { product: Awaited<ReturnType<typeof createProduct>>; quantity: number }[],
    paid?: string,
  ) {
    return checkout(runner.ctx, {
      customerId,
      idempotencyKey: randomUUID(),
      lines: lines.map((l) => ({
        productId: l.product.id,
        productUomId: l.product.caseUomId,
        quantity: l.quantity,
      })),
      ...(paid ? { payment: { method: 'CASH' as const, amount: paid } } : {}),
    })
  }

  const saleRow = (saleId: string) =>
    db(org.ownerCtx).sale.findUniqueOrThrow({
      where: { id: saleId },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    })

  // ── item 6: the tax snapshot ──────────────────────────────────────────────

  describe('the tax regime', () => {
    it('records the rate, its code and its jurisdiction on the sale', async () => {
      const sale = await sell([{ product: taxable, quantity: 2 }])
      const row = await saleRow(sale.saleId)

      expect(readTaxSnapshot(row.taxJson)).toEqual({
        rateId: ohio,
        name: 'Ohio 7.25%',
        code: 'OH-STATE',
        jurisdiction: 'Erie County, OH',
        rate: '0.0725',
        exempt: false,
        exemptId: null,
      })
    })

    it('records the basis and the rate on every line', async () => {
      const sale = await sell([
        { product: taxable, quantity: 2 },
        { product: exemptGoods, quantity: 3 },
      ])
      const row = await saleRow(sale.saleId)

      const [snacks, water] = row.items
      expect(snacks.taxable).toBe(true)
      expect(snacks.taxableAmount.toString()).toBe('40')
      expect(snacks.taxRateApplied.toString()).toBe('0.0725')
      expect(snacks.taxAmount.toString()).toBe('2.9')

      // Water was never taxable. That is a different fact from "taxed at zero",
      // and the two are distinguishable on the row.
      expect(water.taxable).toBe(false)
      expect(water.taxableAmount.toString()).toBe('0')
      expect(water.taxRateApplied.toString()).toBe('0')
      expect(water.taxAmount.toString()).toBe('0')
    })

    it('does not change when the rate changes afterwards', async () => {
      const sale = await sell([{ product: taxable, quantity: 2 }])

      await db(org.ownerCtx).taxRate.update({
        where: { id: ohio },
        data: { rate: '0.0800', name: 'Ohio 8%', jurisdiction: 'Ohio' },
      })

      const row = await saleRow(sale.saleId)
      const snapshot = readTaxSnapshot(row.taxJson)!
      expect(snapshot.rate).toBe('0.0725')
      expect(snapshot.name).toBe('Ohio 7.25%')
      expect(snapshot.jurisdiction).toBe('Erie County, OH')
      expect(row.taxTotal.toString()).toBe('2.9')
      expect(row.items[0].taxRateApplied.toString()).toBe('0.0725')
    })

    it('does not change when the store becomes exempt afterwards', async () => {
      const sale = await sell([{ product: taxable, quantity: 2 }])

      await db(org.ownerCtx).customer.update({
        where: { id: customerId },
        data: { taxExempt: true, taxExemptId: 'OH-98-7654321' },
      })

      const row = await saleRow(sale.saleId)
      expect(readTaxSnapshot(row.taxJson)!.exempt).toBe(false)
      expect(row.taxExempt).toBe(false)
      expect(row.taxTotal.toString()).toBe('2.9')
    })

    it('records the exemption and the certificate behind it', async () => {
      await db(org.ownerCtx).customer.update({
        where: { id: customerId },
        data: { taxExempt: true, taxExemptId: 'OH-98-7654321' },
      })

      const sale = await sell([{ product: taxable, quantity: 2 }])
      const row = await saleRow(sale.saleId)
      const snapshot = readTaxSnapshot(row.taxJson)!

      expect(snapshot.exempt).toBe(true)
      expect(snapshot.exemptId).toBe('OH-98-7654321')
      // No rate was applied, so none is recorded: a rate sitting next to
      // `exempt: true` is an invitation to multiply by it.
      expect(snapshot.rate).toBe('0')
      expect(row.taxTotal.toString()).toBe('0')

      // The goods were taxable and the basis is still there. Without it, an
      // exemption report would have to reconstruct the figure from settings
      // that have since moved.
      const [line] = row.items
      expect(line.taxable).toBe(true)
      expect(line.taxableAmount.toString()).toBe('40')
      expect(line.taxRateApplied.toString()).toBe('0')
      expect(line.taxAmount.toString()).toBe('0')
    })

    it('reverses a return at the rate that was charged, not today’s', async () => {
      const sale = await sell([{ product: taxable, quantity: 4 }])
      const [item] = (await saleRow(sale.saleId)).items

      await db(org.ownerCtx).taxRate.update({
        where: { id: ohio },
        data: { rate: '0.1500', name: 'Ohio 15%' },
      })
      await db(org.ownerCtx).customer.update({
        where: { id: customerId },
        data: { taxExempt: true, taxExemptId: 'LATER' },
      })

      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 2, disposition: 'DAMAGED' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const memo = await db(org.ownerCtx).creditMemo.findUniqueOrThrow({
        where: { id: result.creditMemoId! },
        include: { items: true },
      })

      // Half the goods back: half the tax ACTUALLY charged, at 7.25%.
      expect(memo.taxTotal.toString()).toBe('2.9')
      const [line] = memo.items
      expect(line.taxable).toBe(true)
      expect(line.taxableAmount.toString()).toBe('40')
      expect(line.taxRateApplied.toString()).toBe('0.0725')

      // And the credit carries the sale's regime, so the document says which
      // tax it is reversing without consulting anything current.
      expect(readTaxSnapshot(memo.taxJson)).toEqual(readTaxSnapshot((await saleRow(sale.saleId)).taxJson))
    })
  })

  // ── item 5: the document type is decided once ─────────────────────────────

  describe('what kind of document it is', () => {
    it('is a sales receipt when it was settled at the counter', async () => {
      const sale = await sell([{ product: taxable, quantity: 2 }], '42.90')
      const row = await saleRow(sale.saleId)

      expect(row.balanceDue.toString()).toBe('0')
      expect(row.documentType).toBe('SALES_RECEIPT')
    })

    it('is an invoice when anything is still owed', async () => {
      const unpaid = await saleRow((await sell([{ product: taxable, quantity: 2 }])).saleId)
      expect(unpaid.documentType).toBe('INVOICE')

      const partial = await saleRow((await sell([{ product: taxable, quantity: 2 }], '10.00')).saleId)
      expect(partial.documentType).toBe('INVOICE')
    })

    it('stays an invoice after it is paid in full', async () => {
      // The one the spec names: Sale A is invoiced, the store pays it off next
      // month, and it must NOT retroactively become a counter sale — the
      // receivable existed, and so did the payment against it.
      const sale = await sell([{ product: taxable, quantity: 2 }])
      expect((await saleRow(sale.saleId)).documentType).toBe('INVOICE')

      await recordPayment(office.ctx, {
        customerId,
        method: 'CHECK',
        amount: '42.90',
        checkNumber: '10441',
        strategy: 'OLDEST_FIRST',
        idempotencyKey: randomUUID(),
      })

      const settled = await saleRow(sale.saleId)
      expect(settled.balanceDue.toString()).toBe('0')
      expect(settled.documentType).toBe('INVOICE')
    })

    it('stays a sales receipt after it is credited', async () => {
      const sale = await sell([{ product: taxable, quantity: 2 }], '42.90')
      const [item] = (await saleRow(sale.saleId)).items

      await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 2, disposition: 'DAMAGED' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      expect((await saleRow(sale.saleId)).documentType).toBe('SALES_RECEIPT')
    })

    it('is never recomputed, only read', async () => {
      // Nothing outside checkout may write this column. If a future change
      // starts deriving it, this is the test that says so.
      const service = await import('node:fs/promises').then((fs) =>
        fs.readFile('src/server/services/sale.service.ts', 'utf8'),
      )
      expect(service.match(/documentType:/g) ?? []).toHaveLength(1)
    })
  })
})
