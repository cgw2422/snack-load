import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { findBalanceDrift } from '@/server/services/inventory.service'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { getReceiptDocument } from '@/server/documents/receiptDocument'
import {
  checkout,
  getOpenInvoices,
  getRepeatLines,
  listSales,
  priceCart,
  voidSale,
} from '@/server/services/sale.service'
import { recordPayment, reversePayment, getReceivables } from '@/server/services/payment.service'
import {
  addMember,
  balanceOf,
  createCustomer,
  createProduct,
  createTestOrg,
  type TestOrg,
} from '../helpers'

/**
 * The sales loop: price, sell, take money, give a receipt. This is where the
 * money rules in docs/02 finally meet the stock rules.
 */
describe('sales', () => {
  let org: TestOrg
  let runner: Awaited<ReturnType<typeof addMember>>
  let customerId: string
  let product: Awaited<ReturnType<typeof createProduct>>
  let truckLocation: string

  beforeEach(async () => {
    org = await createTestOrg()
    runner = await addMember(org, 'runner', { firstName: 'Mike', lastName: 'Donnelly' })

    const customer = await createCustomer(org.organizationId)
    customerId = customer.id

    product = await createProduct(org.organizationId, {
      unitsPerCase: 12,
      casePrice: '19.50',
      unitPrice: '2.29',
      costPerBaseUnit: '1.200000',
    })

    // Stock into the warehouse, then onto the runner's truck.
    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 40, unitCost: '14.40' }],
    })

    const vehicle = await createVehicle(org.ownerCtx, {
      name: 'Truck #2', truckNumber: '2', active: true, assignedUserId: runner.userId,
    })
    const row = await db(org.ownerCtx).vehicle.findFirst({ where: { id: vehicle.id } })
    truckLocation = row!.locationId

    await db(org.ownerCtx).membership.updateMany({
      where: { userId: runner.userId },
      data: { defaultVehicleId: vehicle.id },
    })

    await moveTruckStock(org.ownerCtx, {
      vehicleId: vehicle.id,
      warehouseLocationId: org.warehouseLocationId,
      direction: 'LOAD',
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 20 }],
    })
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  const cartLines = (quantity = 3) => [
    { productId: product.id, productUomId: product.caseUomId, quantity },
  ]

  describe('pricing a cart', () => {
    it('uses the list price for the chosen unit', async () => {
      const cart = await priceCart(runner.ctx, { customerId, lines: cartLines(3) })
      expect(cart.lines[0].unitPrice).toBe('19.50')
      expect(cart.lines[0].priceSource).toBe('STANDARD')
      expect(cart.subtotal).toBe('58.50')
      expect(cart.total).toBe('58.50')
    })

    it("prefers a customer's negotiated price", async () => {
      await db(org.ownerCtx).customerPrice.create({
        data: {
          organizationId: org.organizationId,
          customerId,
          productId: product.id,
          productUomId: product.caseUomId,
          price: '18.75',
        },
      })

      const cart = await priceCart(runner.ctx, { customerId, lines: cartLines(3) })
      expect(cart.lines[0].unitPrice).toBe('18.75')
      expect(cart.lines[0].priceSource).toBe('CUSTOMER')
      expect(cart.total).toBe('56.25')
    })

    it('charges tax when the customer is not exempt', async () => {
      const rate = await db(org.ownerCtx).taxRate.create({
        data: { organizationId: org.organizationId, name: 'Ohio', rate: '0.0725' },
        select: { id: true },
      })
      await db(org.ownerCtx).customer.update({
        where: { id: customerId },
        data: { taxRateId: rate.id },
      })

      const cart = await priceCart(runner.ctx, { customerId, lines: cartLines(3) })
      // 58.50 × 0.0725 = 4.24125 → 4.24
      expect(cart.taxTotal).toBe('4.24')
      expect(cart.total).toBe('62.74')
    })

    it('ignores a manual price from someone without the permission', async () => {
      const cart = await priceCart(runner.ctx, {
        customerId,
        lines: [{ ...cartLines(1)[0], manualPrice: '1.00' }],
      })
      expect(cart.lines[0].unitPrice).toBe('19.50')
      expect(cart.lines[0].priceSource).toBe('STANDARD')
    })

    it('honours a manual price from someone who may override', async () => {
      const cart = await priceCart(org.ownerCtx, {
        customerId,
        lines: [{ ...cartLines(1)[0], manualPrice: '15.00' }],
      })
      expect(cart.lines[0].unitPrice).toBe('15.00')
      expect(cart.lines[0].priceSource).toBe('MANUAL')
    })

    it('says what is on the truck, so a runner is not surprised at checkout', async () => {
      const cart = await priceCart(runner.ctx, { customerId, lines: cartLines(3) })
      expect(cart.sellingLocationName).toBe('Truck #2')
      expect(cart.lines[0].available).toBe(240)
    })

    it('refuses a unit belonging to another product', async () => {
      const other = await createProduct(org.organizationId, { sku: `OTHER-${Date.now()}` })
      await expect(
        priceCart(runner.ctx, {
          customerId,
          lines: [{ productId: product.id, productUomId: other.caseUomId, quantity: 1 }],
        }),
      ).rejects.toThrow(/does not belong to/i)
    })
  })

  describe('checkout', () => {
    it('sells, takes the cash, and leaves nothing owing', async () => {
      const result = await checkout(runner.ctx, {
        customerId,
        lines: cartLines(3),
        idempotencyKey: randomUUID(),
        payment: { method: 'CASH', amount: '58.50' },
      })

      expect(result.total).toBe('58.50')
      expect(result.amountPaid).toBe('58.50')
      expect(result.balanceDue).toBe('0.00')
      expect(result.saleNumber).toMatch(/^S-/)
      expect(result.receiptNumber).toMatch(/^R-/)
    })

    it('takes the stock off the truck, not the warehouse', async () => {
      await checkout(runner.ctx, {
        customerId,
        lines: cartLines(3),
        idempotencyKey: randomUUID(),
        payment: { method: 'CASH', amount: '58.50' },
      })

      expect(await balanceOf(truckLocation, product.id)).toBe(240 - 36)
      expect(await balanceOf(org.warehouseLocationId, product.id)).toBe(240)
      expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
    })

    it('snapshots the cost so a later price change cannot restate the month', async () => {
      await checkout(runner.ctx, {
        customerId, lines: cartLines(3), idempotencyKey: randomUUID(),
      })

      const item = await db(org.ownerCtx).saleItem.findFirst({})
      expect(item?.unitCostAtSale.toString()).toBe('1.2')

      // Cost moves afterwards; the sold line must not follow it.
      await db(org.ownerCtx).product.update({
        where: { id: product.id },
        data: { costPerBaseUnit: '9.999999' },
      })
      const again = await db(org.ownerCtx).saleItem.findFirst({})
      expect(again?.unitCostAtSale.toString()).toBe('1.2')
    })

    it('snapshots the product name so a rename cannot rewrite a printed receipt', async () => {
      const sale = await checkout(runner.ctx, {
        customerId, lines: cartLines(1), idempotencyKey: randomUUID(),
      })
      await db(org.ownerCtx).product.update({
        where: { id: product.id },
        data: { name: 'Renamed Entirely' },
      })

      const receipt = await getReceiptDocument(org.ownerCtx, sale.saleId)
      expect(receipt.lines[0].name).toBe('Takis Fuego')
    })

    it('leaves a balance when the store pays part of it', async () => {
      // The spec's example: a $500 sale paid $200 leaves $300.
      const result = await checkout(runner.ctx, {
        customerId,
        lines: cartLines(3),
        idempotencyKey: randomUUID(),
        payment: { method: 'CASH', amount: '20.00' },
      })
      expect(result.balanceDue).toBe('38.50')

      const customer = await db(org.ownerCtx).customer.findFirst({ where: { id: customerId } })
      expect(customer?.balance.toString()).toBe('38.5')
    })

    it('puts the whole sale on account when nothing is paid', async () => {
      const result = await checkout(runner.ctx, {
        customerId, lines: cartLines(3), idempotencyKey: randomUUID(),
      })
      expect(result.balanceDue).toBe('58.50')

      const open = await getOpenInvoices(org.ownerCtx, customerId)
      expect(open).toHaveLength(1)
      expect(open[0].balanceDue).toBe('58.50')
    })

    it('refuses to take more than the sale is worth', async () => {
      await expect(
        checkout(runner.ctx, {
          customerId,
          lines: cartLines(1),
          idempotencyKey: randomUUID(),
          payment: { method: 'CASH', amount: '500.00' },
        }),
      ).rejects.toThrow(/more than the sale total/i)
    })

    it('bills once when a submission is retried', async () => {
      const key = randomUUID()
      const input = {
        customerId,
        lines: cartLines(3),
        idempotencyKey: key,
        payment: { method: 'CASH' as const, amount: '58.50' },
      }

      const first = await checkout(runner.ctx, input)
      const second = await checkout(runner.ctx, input)

      expect(second.replayed).toBe(true)
      expect(second.saleId).toBe(first.saleId)
      expect(await db(org.ownerCtx).sale.count()).toBe(1)
      // And the truck was not emptied twice.
      expect(await balanceOf(truckLocation, product.id)).toBe(240 - 36)
    })

    it('will not sell what is not on the truck', async () => {
      await expect(
        checkout(runner.ctx, {
          customerId,
          lines: cartLines(25),
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/Not enough stock/i)

      // Nothing was written: no sale, no movement.
      expect(await db(org.ownerCtx).sale.count()).toBe(0)
      expect(await balanceOf(truckLocation, product.id)).toBe(240)
    })

    it('refuses a discount from someone who may not discount', async () => {
      await expect(
        checkout(runner.ctx, {
          customerId,
          lines: cartLines(3),
          documentDiscount: '5.00',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/permission to discount/i)
    })

    it('keeps a signature with the sale', async () => {
      const tinyPng =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      const sale = await checkout(runner.ctx, {
        customerId,
        lines: cartLines(1),
        idempotencyKey: randomUUID(),
        signature: { signerName: 'Joe Bianchi', imageDataUrl: tinyPng },
      })

      const receipt = await getReceiptDocument(org.ownerCtx, sale.saleId)
      expect(receipt.signature?.signerName).toBe('Joe Bianchi')
    })

    it('records who sold it and totals that add up', async () => {
      const sale = await checkout(runner.ctx, {
        customerId, lines: cartLines(3), idempotencyKey: randomUUID(),
        payment: { method: 'CHECK', amount: '58.50', checkNumber: '1042' },
      })

      const receipt = await getReceiptDocument(org.ownerCtx, sale.saleId)
      expect(receipt.soldByName).toBe('Mike Donnelly')
      expect(receipt.payments[0]).toMatchObject({ method: 'CHECK', reference: '1042' })

      const lineSum = receipt.lines.reduce((n, i) => n + Number(i.lineTotal), 0)
      expect(lineSum.toFixed(2)).toBe(receipt.total)
    })

    it('keeps one runner from reading another runner\'s receipt', async () => {
      const other = await addMember(org, 'runner', { firstName: 'Sarah', lastName: 'Nguyen' })
      const sale = await checkout(runner.ctx, {
        customerId, lines: cartLines(1), idempotencyKey: randomUUID(),
      })
      await expect(getReceiptDocument(other.ctx, sale.saleId)).rejects.toThrow(/not found/i)
    })
  })

  describe('voiding', () => {
    it('puts the stock back and clears the balance', async () => {
      const sale = await checkout(runner.ctx, {
        customerId, lines: cartLines(3), idempotencyKey: randomUUID(),
      })
      expect(await balanceOf(truckLocation, product.id)).toBe(240 - 36)

      await voidSale(org.ownerCtx, sale.saleId, 'Rang up the wrong store')

      expect(await balanceOf(truckLocation, product.id)).toBe(240)
      const customer = await db(org.ownerCtx).customer.findFirst({ where: { id: customerId } })
      expect(customer?.balance.toString()).toBe('0')
      expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
    })

    it('leaves the original readable rather than deleting it', async () => {
      const sale = await checkout(runner.ctx, {
        customerId, lines: cartLines(3), idempotencyKey: randomUUID(),
      })
      await voidSale(org.ownerCtx, sale.saleId, 'Mistake')

      const receipt = await getReceiptDocument(org.ownerCtx, sale.saleId)
      expect(receipt.status).toBe('VOIDED')
      expect(receipt.lines).toHaveLength(1)
    })

    it('returns money taken on the sale to the payment as credit', async () => {
      const sale = await checkout(runner.ctx, {
        customerId, lines: cartLines(3), idempotencyKey: randomUUID(),
        payment: { method: 'CASH', amount: '58.50' },
      })
      await voidSale(org.ownerCtx, sale.saleId, 'Wrong store')

      const payment = await db(org.ownerCtx).payment.findFirst({})
      expect(payment?.unappliedAmount.toString()).toBe('58.5')
    })

    it('refuses to void twice', async () => {
      const sale = await checkout(runner.ctx, {
        customerId, lines: cartLines(1), idempotencyKey: randomUUID(),
      })
      await voidSale(org.ownerCtx, sale.saleId, 'Mistake')
      await expect(voidSale(org.ownerCtx, sale.saleId, 'Again')).rejects.toThrow(/completed sale/i)
    })

    it('keeps a runner from voiding a sale', async () => {
      const sale = await checkout(runner.ctx, {
        customerId, lines: cartLines(1), idempotencyKey: randomUUID(),
      })
      await expect(voidSale(runner.ctx, sale.saleId, 'Oops')).rejects.toThrow(/permission/i)
    })
  })

  describe('payments on account', () => {
    beforeEach(async () => {
      // Three unpaid sales, oldest first.
      for (const [index, quantity] of [3, 2, 1].entries()) {
        await checkout(runner.ctx, {
          customerId,
          lines: cartLines(quantity),
          idempotencyKey: randomUUID(),
        })
        await db(org.ownerCtx).sale.updateMany({
          where: { balanceDue: { gt: 0 }, dueDate: null },
          data: { dueDate: new Date(`2026-0${index + 1}-01T00:00:00Z`) },
        })
      }
    })

    it('clears the oldest debt first', async () => {
      const result = await recordPayment(org.ownerCtx, {
        customerId,
        method: 'CHECK',
        amount: '80.00',
        strategy: 'OLDEST_FIRST',
        idempotencyKey: randomUUID(),
      })

      expect(result.applied).toBe('80.00')
      expect(result.unapplied).toBe('0.00')
      expect(result.clearedInvoices).toBe(1)

      const open = await getOpenInvoices(org.ownerCtx, customerId)
      // 58.50 cleared, 21.50 off the next.
      expect(open).toHaveLength(2)
      expect(open[0].balanceDue).toBe('17.50')
    })

    it('keeps an over-payment as credit rather than a negative balance', async () => {
      const result = await recordPayment(org.ownerCtx, {
        customerId, method: 'CASH', amount: '500.00',
        strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
      })

      expect(result.applied).toBe('117.00')
      expect(result.unapplied).toBe('383.00')

      const customer = await db(org.ownerCtx).customer.findFirst({ where: { id: customerId } })
      expect(Number(customer?.balance)).toBe(0)
    })

    it('applies a payment to the invoices named', async () => {
      const open = await getOpenInvoices(org.ownerCtx, customerId)
      const result = await recordPayment(org.ownerCtx, {
        customerId, method: 'CASH', amount: '19.50',
        strategy: 'SPECIFIC',
        allocations: [{ saleId: open[2].saleId, amount: '19.50' }],
        idempotencyKey: randomUUID(),
      })

      expect(result.clearedInvoices).toBe(1)
      const after = await getOpenInvoices(org.ownerCtx, customerId)
      expect(after.map((i) => i.saleId)).not.toContain(open[2].saleId)
    })

    it('refuses to apply more to an invoice than it owes', async () => {
      const open = await getOpenInvoices(org.ownerCtx, customerId)
      await expect(
        recordPayment(org.ownerCtx, {
          customerId, method: 'CASH', amount: '100.00',
          strategy: 'SPECIFIC',
          allocations: [{ saleId: open[0].saleId, amount: '100.00' }],
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/only owes/i)
    })

    it('records a retried payment once', async () => {
      const key = randomUUID()
      const input = {
        customerId, method: 'CASH' as const, amount: '50.00',
        strategy: 'OLDEST_FIRST' as const, idempotencyKey: key,
      }
      await recordPayment(org.ownerCtx, input)
      const second = await recordPayment(org.ownerCtx, input)

      expect(second.replayed).toBe(true)
      expect(await db(org.ownerCtx).payment.count()).toBe(1)
    })

    it('reverses a payment and puts the debt back', async () => {
      const payment = await recordPayment(org.ownerCtx, {
        customerId, method: 'CHECK', amount: '58.50',
        strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
      })

      const before = await db(org.ownerCtx).customer.findFirst({ where: { id: customerId } })
      await reversePayment(org.ownerCtx, payment.paymentId, 'Check bounced')
      const after = await db(org.ownerCtx).customer.findFirst({ where: { id: customerId } })

      expect(Number(after?.balance) - Number(before?.balance)).toBeCloseTo(58.5, 2)

      const row = await db(org.ownerCtx).payment.findFirst({ where: { id: payment.paymentId } })
      expect(row?.status).toBe('REVERSED')
    })

    it('totals receivables across the company', async () => {
      const { rows, total } = await getReceivables(org.ownerCtx)
      expect(rows).toHaveLength(1)
      expect(rows[0].invoiceCount).toBe(3)
      expect(total).toBe('117.00')
    })
  })

  describe('the screens that read sales back', () => {
    let saleId: string

    beforeEach(async () => {
      const result = await checkout(runner.ctx, {
        customerId,
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 2 }],
      })
      saleId = result.saleId
    })

    it("shows a runner their own sales and nobody else's", async () => {
      const other = await addMember(org, 'runner', { firstName: 'Dana', lastName: 'Ruiz' })

      const mine = await listSales(runner.ctx)
      const theirs = await listSales(other.ctx)
      const everything = await listSales(org.ownerCtx)

      expect(mine.items.map((s) => s.id)).toEqual([saleId])
      // Scoping is in the WHERE clause, so the count agrees with the rows.
      expect(theirs.items).toHaveLength(0)
      expect(theirs.total).toBe(0)
      expect(everything.items.map((s) => s.id)).toContain(saleId)
    })

    it('finds a sale by receipt number or store name', async () => {
      const sale = await db(org.ownerCtx).sale.findFirstOrThrow({ where: { id: saleId } })

      expect((await listSales(org.ownerCtx, { search: sale.saleNumber })).items).toHaveLength(1)
      expect((await listSales(org.ownerCtx, { search: 'Marathon' })).items.length).toBeGreaterThan(0)
      expect((await listSales(org.ownerCtx, { search: 'nothing-like-this' })).items).toHaveLength(0)
    })

    it('rebuilds a cart from an earlier order', async () => {
      const lines = await getRepeatLines(runner.ctx, saleId)

      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        productId: product.id,
        productUomId: product.caseUomId,
        quantity: 2,
      })
      expect(lines[0].uoms.some((u) => u.id === product.caseUomId)).toBe(true)
    })

    it('leaves a discontinued product out of a repeat rather than substituting', async () => {
      await db(org.ownerCtx).product.update({
        where: { id: product.id },
        data: { active: false },
      })

      expect(await getRepeatLines(runner.ctx, saleId)).toHaveLength(0)
    })

    it("lets a runner who can take money see that store's open invoices", async () => {
      // The runner holds payment:create but not payment:read.
      const invoices = await getOpenInvoices(runner.ctx, customerId)
      expect(invoices.length).toBeGreaterThan(0)

      // The org-wide AR book stays shut to them.
      await expect(getReceivables(runner.ctx)).rejects.toThrow()
    })
  })
})
