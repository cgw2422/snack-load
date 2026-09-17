import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { findBalanceDrift } from '@/server/services/inventory.service'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout } from '@/server/services/sale.service'
import { recordPayment } from '@/server/services/payment.service'
import { createReturn, getReturnableLines, voidReturn } from '@/server/services/return.service'
import { runReport, type ReportRow } from '@/server/reports'
import { getCreditDocument, getPublicCreditDocument } from '@/server/documents/creditDocument'
import { renderReceiptPdf } from '@/server/documents/receiptPdf'
import { createShareLink, resolveShareToken } from '@/server/services/shareLink.service'
import { emailReceipt, listDeliveries } from '@/server/services/delivery.service'
import { resetProviders, setProvidersForTesting } from '@/server/messaging'
import type { EmailMessage, EmailProvider } from '@/server/messaging'
import {
  applyCreditMemo,
  createAdjustmentCredit,
  getCreditPosition,
  issueRefund,
  unapplyCreditMemo,
  voidCreditMemo,
  voidRefund,
} from '@/server/services/credit.service'
import {
  addMember,
  balanceOf,
  createCustomer,
  createProduct,
  createTestOrg,
  type TestOrg,
} from '../helpers'

/**
 * Returns, credits and refunds (spec §1–§9, §20).
 *
 * The properties under test are the ones an accountant would ask about:
 * a posted sale is never edited, a credit is a proportion of what was actually
 * charged, unapplied credit has not touched any invoice, goods that came back
 * damaged do not become sellable again, and nothing can be unwound into an
 * impossible state.
 */
describe('returns and credits', () => {
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

    // A tax rate on the org, so the tax-reversal tests have tax to reverse.
    const taxRate = await db(org.ownerCtx).taxRate.create({
      data: {
        organizationId: org.organizationId,
        name: 'Ohio 7.25%',
        rate: '0.0725',
        isDefault: true,
      },
      select: { id: true },
    })

    const customer = await createCustomer(org.organizationId)
    customerId = customer.id
    await db(org.ownerCtx).customer.update({
      where: { id: customerId },
      data: { taxRateId: taxRate.id },
    })

    product = await createProduct(org.organizationId, {
      name: 'Takis Fuego',
      unitsPerCase: 12,
      casePrice: '19.50',
      unitPrice: '2.29',
      costPerBaseUnit: '1.200000',
      taxable: true,
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
    const row = await db(org.ownerCtx).vehicle.findFirstOrThrow({ where: { id: vehicle.id } })
    truckLocation = row.locationId

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

  async function sell(cases: number, paid?: string) {
    return checkout(runner.ctx, {
      customerId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: cases }],
      ...(paid ? { payment: { method: 'CASH' as const, amount: paid } } : {}),
    })
  }

  async function firstSaleItem(saleId: string) {
    return db(org.ownerCtx).saleItem.findFirstOrThrow({ where: { saleId } })
  }

  async function holdBalance(kind: 'DAMAGED_HOLD' | 'EXPIRED_HOLD' | 'SUPPLIER_RETURN_HOLD') {
    const location = await db(org.ownerCtx).inventoryLocation.findFirst({ where: { kind } })
    return location ? balanceOf(location.id, product.id) : 0
  }

  // ── §1 returnable quantity ────────────────────────────────────────────────

  describe('what may be returned', () => {
    it('offers everything that was sold, and nothing that was not', async () => {
      const sale = await sell(3)
      const view = await getReturnableLines(runner.ctx, sale.saleId)

      expect(view.lines).toHaveLength(1)
      expect(view.lines[0]).toMatchObject({
        soldQuantity: 3,
        soldBaseQuantity: 36,
        returnedBaseQuantity: 0,
        returnableQuantity: 3,
      })
    })

    it('counts what has already come back', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)

      await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const view = await getReturnableLines(runner.ctx, sale.saleId)
      expect(view.lines[0].returnableQuantity).toBe(2)
      expect(view.lines[0].returnedBaseQuantity).toBe(12)
    })

    it('refuses more than was sold, on the server', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)

      // Scenario E: the UI is not the guard.
      await expect(
        createReturn(runner.ctx, {
          saleId: sale.saleId,
          reason: 'UNSOLD',
          lines: [{ saleItemId: item.id, quantity: 4, disposition: 'RESTOCK_TRUCK' }],
          financialAction: 'ACCOUNT_CREDIT',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/only 3 cases can still be returned/i)
    })

    it('refuses more than what is LEFT after an earlier return', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)

      await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 2, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      await expect(
        createReturn(runner.ctx, {
          saleId: sale.saleId,
          reason: 'UNSOLD',
          lines: [{ saleItemId: item.id, quantity: 2, disposition: 'RESTOCK_TRUCK' }],
          financialAction: 'ACCOUNT_CREDIT',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/only 1 case can still be returned/i)
    })

    it('makes units returnable again once the return is voided', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)

      const returned = await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 2, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })
      await voidReturn(office.ctx, returned.returnId, 'Rang up the wrong store')

      const view = await getReturnableLines(runner.ctx, sale.saleId)
      expect(view.lines[0].returnableQuantity).toBe(3)
    })
  })

  // ── §5 historical tax ─────────────────────────────────────────────────────

  describe('the credit', () => {
    it('reverses the tax that was actually charged, prorated', async () => {
      // 4 cases at $19.50 = $78.00 plus 7.25% tax = $5.66.
      const sale = await sell(4)
      const item = await firstSaleItem(sale.saleId)
      expect(toNumber(item.taxAmount)).toBeCloseTo(5.66, 2)

      // Half the merchandise comes back.
      const result = await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 2, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const memo = await db(org.ownerCtx).creditMemo.findFirstOrThrow({
        where: { id: result.creditMemoId! },
        select: { subtotal: true, taxTotal: true, amount: true },
      })
      expect(memo.subtotal.toString()).toBe('39')
      expect(toNumber(memo.taxTotal)).toBeCloseTo(2.83, 2)
      expect(toNumber(memo.amount)).toBeCloseTo(41.83, 2)
    })

    it('credits the whole line exactly when the whole line comes back', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)

      const result = await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 3, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      // No rounding drift on the common case.
      expect(result.creditTotal).toBe(toAmount(item.lineTotal))
    })

    it('ignores a later price change and uses what was charged', async () => {
      const sale = await sell(2)
      const item = await firstSaleItem(sale.saleId)

      await db(org.ownerCtx).productUom.update({
        where: { id: product.caseUomId },
        data: { price: '99.00' },
      })

      const result = await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const line = await db(org.ownerCtx).creditMemoItem.findFirstOrThrow({
        where: { creditMemoId: result.creditMemoId! },
      })
      expect(line.unitPrice.toString()).toBe('19.5')
    })

    it('snapshots the description so a rename cannot rewrite it', async () => {
      const sale = await sell(1)
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      await db(org.ownerCtx).product.update({
        where: { id: product.id },
        data: { name: 'Renamed Entirely' },
      })

      const line = await db(org.ownerCtx).creditMemoItem.findFirstOrThrow({
        where: { creditMemoId: result.creditMemoId! },
      })
      expect(line.descriptionSnapshot).toBe('Takis Fuego')
    })

    it('never edits the sale it credits', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)
      const before = await firstSaleItem(sale.saleId)

      await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const after = await firstSaleItem(sale.saleId)
      expect(after.quantity).toBe(before.quantity)
      expect(after.baseQuantity).toBe(before.baseQuantity)
      expect(after.lineTotal.toString()).toBe(before.lineTotal.toString())
      expect(await db(org.ownerCtx).saleItem.count({ where: { saleId: sale.saleId } })).toBe(1)
    })
  })

  // ── §3 inventory disposition ──────────────────────────────────────────────

  describe('where the goods go', () => {
    it('puts sellable stock back on the truck it left on', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)
      expect(await balanceOf(truckLocation, product.id)).toBe(480 - 36)

      await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      expect(await balanceOf(truckLocation, product.id)).toBe(480 - 36 + 12)
    })

    it('does NOT make a damaged return sellable again', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)
      const truckAfterSale = await balanceOf(truckLocation, product.id)

      await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 2, disposition: 'DAMAGED' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      // Scenario D: the truck is untouched, and the goods are recorded as held.
      expect(await balanceOf(truckLocation, product.id)).toBe(truckAfterSale)
      expect(await balanceOf(org.warehouseLocationId, product.id)).toBe(240)
      expect(await holdBalance('DAMAGED_HOLD')).toBe(24)

      const location = await db(org.ownerCtx).inventoryLocation.findFirstOrThrow({
        where: { kind: 'DAMAGED_HOLD' },
      })
      expect(location.sellable).toBe(false)
    })

    it('names the disposition in the ledger rather than leaving it to be guessed', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)

      await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'EXPIRED',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'EXPIRED' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const posted = await db(org.ownerCtx).inventoryTransaction.findFirstOrThrow({
        where: { referenceType: 'Return' },
        select: { type: true },
      })
      expect(posted.type).toBe('CUSTOMER_RETURN_EXPIRED')
      expect(await holdBalance('EXPIRED_HOLD')).toBe(12)
    })

    it('splits one return across dispositions', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)
      const truckAfterSale = await balanceOf(truckLocation, product.id)

      await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'OTHER',
        lines: [
          { saleItemId: item.id, quantity: 2, disposition: 'RESTOCK_TRUCK', reason: 'UNSOLD' },
          { saleItemId: item.id, quantity: 1, disposition: 'DAMAGED', reason: 'DAMAGED' },
        ],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      expect(await balanceOf(truckLocation, product.id)).toBe(truckAfterSale + 24)
      expect(await holdBalance('DAMAGED_HOLD')).toBe(12)
    })

    it('touches no stock at all for a credit with nothing coming back', async () => {
      const sale = await sell(2)
      const item = await firstSaleItem(sale.saleId)
      const truckAfterSale = await balanceOf(truckLocation, product.id)

      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'PRICING_ERROR',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'NONE' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      expect(await balanceOf(truckLocation, product.id)).toBe(truckAfterSale)
      expect(await db(org.ownerCtx).inventoryTransaction.count({
        where: { referenceType: 'Return' },
      })).toBe(0)

      // No goods came back, so there is no cost to reverse either.
      const line = await db(org.ownerCtx).creditMemoItem.findFirstOrThrow({
        where: { creditMemoId: result.creditMemoId! },
      })
      expect(toNumber(line.unitCostAtSale)).toBe(0)
    })

    it('leaves the ledger and the balance cache in agreement', async () => {
      const sale = await sell(4)
      const item = await firstSaleItem(sale.saleId)

      await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'OTHER',
        lines: [
          { saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' },
          { saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' },
          { saleItemId: item.id, quantity: 1, disposition: 'SUPPLIER_RETURN' },
        ],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
    })
  })

  // ── §6, §7 financial outcomes ─────────────────────────────────────────────

  describe('what the money does', () => {
    it('applies the credit to an open invoice', async () => {
      // Scenario A: sell 3 on account, return 1, apply.
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)
      const before = await db(org.ownerCtx).sale.findFirstOrThrow({ where: { id: sale.saleId } })

      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'APPLY_TO_BALANCE',
        idempotencyKey: randomUUID(),
      })

      const after = await db(org.ownerCtx).sale.findFirstOrThrow({ where: { id: sale.saleId } })
      expect(toNumber(after.balanceDue)).toBeCloseTo(
        toNumber(before.balanceDue) - Number(result.creditTotal),
        2,
      )
      expect(toNumber(after.creditsApplied)).toBeCloseTo(Number(result.creditTotal), 2)
      expect(result.remainingCredit).toBe('0.00')

      const position = await getCreditPosition(org.ownerCtx, customerId)
      expect(position.memoCredit).toBe('0.00')
    })

    it('leaves a credit on the account rather than forcing the balance to zero', async () => {
      // Scenario C: a fully paid sale, returned, no refund.
      const sale = await sell(2, '41.83')
      const item = await firstSaleItem(sale.saleId)

      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const position = await getCreditPosition(org.ownerCtx, customerId)
      expect(position.openInvoices).toBe('0.00')
      expect(position.memoCredit).toBe(result.creditTotal)
      expect(Number(position.net)).toBeLessThan(0)
    })

    it('does not pretend an unapplied credit has reduced an invoice', async () => {
      const paid = await sell(2, '41.83')
      const open = await sell(3)
      const item = await firstSaleItem(paid.saleId)

      await createReturn(office.ctx, {
        saleId: paid.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const invoice = await db(org.ownerCtx).sale.findFirstOrThrow({ where: { id: open.saleId } })
      const position = await getCreditPosition(org.ownerCtx, customerId)

      // The invoice is untouched and the credit is visible beside it, not netted in.
      expect(toNumber(invoice.balanceDue)).toBeCloseTo(toNumber(invoice.total), 2)
      expect(Number(position.openInvoices)).toBeGreaterThan(0)
      expect(Number(position.memoCredit)).toBeGreaterThan(0)
    })

    it('settles the invoice the credit came from before older ones', async () => {
      // An older invoice is sitting open…
      const older = await sell(2)
      await db(org.ownerCtx).sale.update({
        where: { id: older.saleId },
        data: { occurredAt: new Date(Date.now() - 20 * 86_400_000) },
      })
      // …and a case comes back off today's.
      const today = await sell(3)
      const item = await firstSaleItem(today.saleId)

      const result = await createReturn(office.ctx, {
        saleId: today.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'APPLY_TO_BALANCE',
        idempotencyKey: randomUUID(),
      })

      // The bill the store is holding is the one that moves.
      const todaysInvoice = await db(org.ownerCtx).sale.findFirstOrThrow({
        where: { id: today.saleId },
      })
      const olderInvoice = await db(org.ownerCtx).sale.findFirstOrThrow({
        where: { id: older.saleId },
      })

      expect(toNumber(todaysInvoice.creditsApplied)).toBeCloseTo(Number(result.creditTotal), 2)
      expect(toNumber(olderInvoice.creditsApplied)).toBe(0)
      expect(toNumber(olderInvoice.balanceDue)).toBeCloseTo(toNumber(olderInvoice.total), 2)
    })

    it('ages backwards for whatever the originating invoice cannot absorb', async () => {
      const older = await sell(2)
      await db(org.ownerCtx).sale.update({
        where: { id: older.saleId },
        data: { occurredAt: new Date(Date.now() - 20 * 86_400_000) },
      })
      // Today's invoice is paid off, so its whole credit has to go somewhere else.
      const today = await sell(3, '62.74')
      const item = await firstSaleItem(today.saleId)

      const result = await createReturn(office.ctx, {
        saleId: today.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'APPLY_TO_BALANCE',
        idempotencyKey: randomUUID(),
      })

      const olderInvoice = await db(org.ownerCtx).sale.findFirstOrThrow({
        where: { id: older.saleId },
      })
      expect(toNumber(olderInvoice.creditsApplied)).toBeCloseTo(Number(result.applied), 2)
    })

    it('applies a held credit to a later invoice', async () => {
      const paid = await sell(2, '41.83')
      const item = await firstSaleItem(paid.saleId)

      const result = await createReturn(office.ctx, {
        saleId: paid.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const future = await sell(4)
      const applied = await applyCreditMemo(office.ctx, { creditMemoId: result.creditMemoId! })

      expect(applied.applied).toBe(result.creditTotal)
      expect(applied.invoices[0].saleId).toBe(future.saleId)

      const invoice = await db(org.ownerCtx).sale.findFirstOrThrow({ where: { id: future.saleId } })
      expect(toNumber(invoice.balanceDue)).toBeCloseTo(
        toNumber(invoice.total) - Number(result.creditTotal),
        2,
      )
    })

    it('refuses to apply more credit than an invoice is short', async () => {
      const paid = await sell(4, '83.66')
      const item = await firstSaleItem(paid.saleId)
      const result = await createReturn(office.ctx, {
        saleId: paid.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 4, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const small = await sell(1)
      await expect(
        applyCreditMemo(office.ctx, {
          creditMemoId: result.creditMemoId!,
          allocations: [{ saleId: small.saleId, amount: '80.00' }],
        }),
      ).rejects.toThrow(/only has/i)
    })

    it('records a refund as its own document, not as a reversed payment', async () => {
      // Scenario B: fully paid sale, goods back, cash out.
      const sale = await sell(2, '41.83')
      const item = await firstSaleItem(sale.saleId)

      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
        financialAction: 'REFUND',
        refund: { method: 'CASH' },
        idempotencyKey: randomUUID(),
      })

      expect(result.refunded).toBe(result.creditTotal)
      expect(result.remainingCredit).toBe('0.00')

      const refund = await db(org.ownerCtx).refund.findFirstOrThrow({
        where: { creditMemoId: result.creditMemoId! },
      })
      expect(refund.refundNumber).toMatch(/^RF-/)
      expect(refund.method).toBe('CASH')
      expect(refund.status).toBe('POSTED')

      // The original payment is untouched: the money did arrive.
      const payment = await db(org.ownerCtx).payment.findFirstOrThrow({ where: { customerId } })
      expect(payment.status).toBe('POSTED')

      const position = await getCreditPosition(org.ownerCtx, customerId)
      expect(position.memoCredit).toBe('0.00')
    })

    it('refuses to refund more than the credit has left', async () => {
      const sale = await sell(2, '41.83')
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      await expect(
        issueRefund(office.ctx, {
          creditMemoId: result.creditMemoId!,
          amount: '500.00',
          method: 'CASH',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/has .* left/i)
    })

    it('issues a credit with nothing coming back at all', async () => {
      const sale = await sell(3)
      const result = await createAdjustmentCredit(office.ctx, {
        customerId,
        saleId: sale.saleId,
        reason: 'PRICING_ERROR',
        description: 'Billed at list instead of the contract price',
        amount: '12.00',
        financialAction: 'APPLY_TO_BALANCE',
        idempotencyKey: randomUUID(),
      })

      expect(result.applied).toBe('12.00')
      expect(await db(org.ownerCtx).inventoryTransaction.count({
        where: { referenceType: 'Return' },
      })).toBe(0)
    })
  })

  // ── §9 voiding ────────────────────────────────────────────────────────────

  describe('unwinding', () => {
    it('sends the goods back out and voids the credit', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)
      const truckAfterSale = await balanceOf(truckLocation, product.id)

      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 2, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })
      expect(await balanceOf(truckLocation, product.id)).toBe(truckAfterSale + 24)

      await voidReturn(office.ctx, result.returnId, 'Entered against the wrong invoice')

      expect(await balanceOf(truckLocation, product.id)).toBe(truckAfterSale)
      expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])

      const memo = await db(org.ownerCtx).creditMemo.findFirstOrThrow({
        where: { id: result.creditMemoId! },
      })
      expect(memo.status).toBe('VOIDED')
      expect(toNumber(memo.remainingAmount)).toBe(0)
    })

    it('keeps the voided return readable rather than deleting it', async () => {
      const sale = await sell(2)
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })
      await voidReturn(office.ctx, result.returnId, 'Mistake')

      const row = await db(org.ownerCtx).return.findFirstOrThrow({
        where: { id: result.returnId },
        select: { status: true, voidReason: true, items: true },
      })
      expect(row.status).toBe('VOIDED')
      expect(row.voidReason).toBe('Mistake')
      expect(row.items).toHaveLength(1)
    })

    it('refuses to void a return whose credit has been refunded', async () => {
      const sale = await sell(2, '41.83')
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
        financialAction: 'REFUND',
        refund: { method: 'CHECK', referenceNumber: '4471' },
        idempotencyKey: randomUUID(),
      })

      await expect(voidReturn(office.ctx, result.returnId, 'Changed our mind')).rejects.toThrow(
        /has already been refunded/i,
      )
    })

    it('refuses to void a return whose credit has been applied', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'APPLY_TO_BALANCE',
        idempotencyKey: randomUUID(),
      })

      await expect(voidReturn(office.ctx, result.returnId, 'Oops')).rejects.toThrow(
        /applied to an invoice/i,
      )
    })

    it('lets the dependents be unwound first, in order', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'APPLY_TO_BALANCE',
        idempotencyKey: randomUUID(),
      })

      const restored = await unapplyCreditMemo(office.ctx, result.creditMemoId!)
      expect(restored.restored).toBe(result.creditTotal)

      // The invoice is whole again…
      const invoice = await db(org.ownerCtx).sale.findFirstOrThrow({ where: { id: sale.saleId } })
      expect(toNumber(invoice.balanceDue)).toBeCloseTo(toNumber(invoice.total), 2)

      // …and now the return will void.
      await voidReturn(office.ctx, result.returnId, 'Entered twice')
      const row = await db(org.ownerCtx).return.findFirstOrThrow({ where: { id: result.returnId } })
      expect(row.status).toBe('VOIDED')
    })

    it('puts credit back when a refund is voided', async () => {
      const sale = await sell(2, '41.83')
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
        financialAction: 'REFUND',
        refund: { method: 'CASH' },
        idempotencyKey: randomUUID(),
      })

      const refund = await db(org.ownerCtx).refund.findFirstOrThrow({
        where: { creditMemoId: result.creditMemoId! },
      })
      await voidRefund(office.ctx, refund.id, 'Cheque never cleared')

      const memo = await db(org.ownerCtx).creditMemo.findFirstOrThrow({
        where: { id: result.creditMemoId! },
      })
      expect(toNumber(memo.remainingAmount)).toBeCloseTo(Number(result.creditTotal), 2)
      expect(toNumber(memo.refundedAmount)).toBe(0)
    })

    it('will not void a standalone credit that has been spent', async () => {
      await sell(3)
      const credit = await createAdjustmentCredit(office.ctx, {
        customerId,
        reason: 'OTHER',
        description: 'Goodwill',
        amount: '10.00',
        financialAction: 'APPLY_TO_BALANCE',
        idempotencyKey: randomUUID(),
      })

      await expect(voidCreditMemo(office.ctx, credit.creditMemoId, 'Wrong store')).rejects.toThrow(
        /applied to an invoice/i,
      )
    })

    it('points a caller at the return rather than voiding its credit behind its back', async () => {
      const sale = await sell(2)
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      await expect(
        voidCreditMemo(office.ctx, result.creditMemoId!, 'Nope'),
      ).rejects.toThrow(/Void the return instead/i)
    })
  })

  // ── §17 permissions ───────────────────────────────────────────────────────

  describe('who may do what', () => {
    it('lets a runner take goods back and credit the account', async () => {
      const sale = await sell(2)
      const item = await firstSaleItem(sale.saleId)

      const result = await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })
      expect(result.creditMemoId).toBeTruthy()
    })

    it('does not let a runner hand over cash', async () => {
      const sale = await sell(2, '41.83')
      const item = await firstSaleItem(sale.saleId)

      await expect(
        createReturn(runner.ctx, {
          saleId: sale.saleId,
          reason: 'DAMAGED',
          lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
          financialAction: 'REFUND',
          refund: { method: 'CASH' },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow()
    })

    it('does not let a runner unwind a posted return', async () => {
      const sale = await sell(2)
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(runner.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      await expect(voidReturn(runner.ctx, result.returnId, 'Nope')).rejects.toThrow()
    })

    it('does not let a warehouse user issue credit', async () => {
      const warehouse = await addMember(org, 'warehouse')
      const sale = await sell(2)
      const item = await firstSaleItem(sale.saleId)

      await expect(
        createReturn(warehouse.ctx, {
          saleId: sale.saleId,
          reason: 'UNSOLD',
          lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
          financialAction: 'ACCOUNT_CREDIT',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow()
    })
  })

  // ── §1 idempotency ────────────────────────────────────────────────────────

  it('replays a repeated submit instead of crediting twice', async () => {
    const sale = await sell(3)
    const item = await firstSaleItem(sale.saleId)
    const key = randomUUID()

    const input = {
      saleId: sale.saleId,
      reason: 'UNSOLD' as const,
      lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' as const }],
      financialAction: 'ACCOUNT_CREDIT' as const,
      idempotencyKey: key,
    }

    const first = await createReturn(runner.ctx, input)
    const second = await createReturn(runner.ctx, input)

    expect(second.replayed).toBe(true)
    expect(second.returnId).toBe(first.returnId)
    expect(await db(org.ownerCtx).return.count()).toBe(1)
    expect(await db(org.ownerCtx).creditMemo.count()).toBe(1)
  })

  // ── §14, §21 reporting ────────────────────────────────────────────────────

  describe('what the reports say', () => {
    const window = { from: dayString(7), to: dayString(-1) }

    it('shows gross, returns and net rather than a pre-netted number', async () => {
      const sale = await sell(4)
      const item = await firstSaleItem(sale.saleId)

      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const report = await runReport(org.ownerCtx, 'sales', { ...window, groupBy: 'customer' })
      const gross = Number(report.totals?.gross)
      const returns = Number(report.totals?.returns)

      expect(gross).toBeCloseTo(83.66, 2)
      expect(returns).toBeCloseTo(Number(result.creditTotal), 2)
      expect(Number(report.totals?.net)).toBeCloseTo(gross - returns, 2)
      // The return is visible, not hidden inside a smaller gross figure.
      expect(returns).toBeGreaterThan(0)
    })

    it('reverses tax alongside the merchandise', async () => {
      const sale = await sell(4)
      const item = await firstSaleItem(sale.saleId)
      await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 4, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const report = await runReport(org.ownerCtx, 'sales', { ...window, groupBy: 'customer' })
      // Everything came back, so net sales and net tax are both zero.
      expect(Number(report.totals?.net)).toBeCloseTo(0, 2)
      expect(Number(report.totals?.tax)).toBeCloseTo(0, 2)
    })

    it('MANDATORY: reverses the ORIGINAL cost, not today\'s', async () => {
      // Spec §21. Sell at a known cost.
      const sale = await sell(1)
      const item = await firstSaleItem(sale.saleId)

      const before = await runReport(org.ownerCtx, 'gross-profit', { ...window })
      // 1 case = 12 base units at $1.20 = $14.40 of COGS on $19.50 of sales.
      expect(before.totals?.netSales).toBe('19.50')
      expect(before.totals?.cogs).toBe('14.40')
      expect(before.totals?.grossProfit).toBe('5.10')

      // The next delivery costs far more, moving the product's current cost.
      await receiveStock(org.ownerCtx, {
        warehouseLocationId: org.warehouseLocationId,
        idempotencyKey: randomUUID(),
        lines: [
          { productId: product.id, productUomId: product.caseUomId, quantity: 40, unitCost: '60.00' },
        ],
      })
      const current = await db(org.ownerCtx).inventoryBalance.findFirstOrThrow({
        where: { locationId: org.warehouseLocationId, productId: product.id },
      })
      expect(Number(current.avgUnitCost)).toBeGreaterThan(1.2)

      // Now return the whole case.
      await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const after = await runReport(org.ownerCtx, 'gross-profit', { ...window })

      // Revenue −$19.50, COGS −$14.40 (the historical figure), gross profit
      // −$5.10. Had today's cost been used, COGS would have gone negative and
      // gross profit would be nonsense.
      expect(after.totals?.netSales).toBe('0.00')
      expect(after.totals?.cogs).toBe('0.00')
      expect(after.totals?.grossProfit).toBe('0.00')
      expect(after.totals?.returns).toBe('19.50')
    })

    it('reverses no cost for a credit with nothing coming back', async () => {
      const sale = await sell(2)
      const item = await firstSaleItem(sale.saleId)

      await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'PRICING_ERROR',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'NONE' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const report = await runReport(org.ownerCtx, 'gross-profit', { ...window })
      // Revenue halves; the cost of two cases stays on the books, because two
      // cases did leave the truck.
      expect(report.totals?.netSales).toBe('19.50')
      expect(report.totals?.cogs).toBe('28.80')
      expect(report.totals?.grossProfit).toBe('-9.30')
    })

    it('keeps damaged returns out of sellable on-hand in the inventory report', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)

      await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 2, disposition: 'DAMAGED' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const report = await runReport(org.ownerCtx, 'inventory', { ...window })
      const row = rowFor(report.rows, 'Takis Fuego')

      // 720 received, 36 sold. The 24 damaged units are held, not on hand.
      expect(row?.onHand).toBe(720 - 36)
      expect(row?.held).toBe(24)
      expect(row?.returnedUnsellable).toBe(24)
      expect(row?.returnedSellable).toBe(0)
    })

    it('shows unapplied credit beside the aging buckets, not inside them', async () => {
      const paid = await sell(2, '41.83')
      const open = await sell(3)
      const item = await firstSaleItem(paid.saleId)

      const result = await createReturn(office.ctx, {
        saleId: paid.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const report = await runReport(org.ownerCtx, 'aging', { ...window })
      const row = rowFor(report.rows, "Joe's Marathon")
      const invoice = await db(org.ownerCtx).sale.findFirstOrThrow({ where: { id: open.saleId } })

      // The open invoice is in a bucket at its full value…
      expect(Number(row?.total)).toBeCloseTo(Number(invoice.total.toString()), 2)
      // …and the credit sits alongside it rather than reducing it.
      expect(Number(row?.credit)).toBeCloseTo(Number(result.creditTotal), 2)
    })

    it('moves money out of a bucket once the credit is applied', async () => {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)
      const before = await runReport(org.ownerCtx, 'aging', { ...window })

      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'APPLY_TO_BALANCE',
        idempotencyKey: randomUUID(),
      })

      const after = await runReport(org.ownerCtx, 'aging', { ...window })
      expect(Number(after.totals?.total)).toBeCloseTo(
        Number(before.totals?.total) - Number(result.creditTotal),
        2,
      )
      expect(after.totals?.credit).toBe('0.00')
    })
  })

  // ── §10 the credit memo document ──────────────────────────────────────────

  describe('the credit memo document', () => {
    async function issue() {
      const sale = await sell(3)
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })
      return { sale, result }
    }

    it('says what was returned, what it credits and where the money went', async () => {
      const { sale, result } = await issue()
      const doc = await getCreditDocument(office.ctx, result.creditMemoId!)

      expect(doc.kind).toBe('creditMemo')
      expect(doc.receiptNumber).toMatch(/^CM-/)
      expect(doc.credit?.againstSaleNumber).toBe(
        (await db(org.ownerCtx).sale.findFirstOrThrow({ where: { id: sale.saleId } })).saleNumber,
      )
      expect(doc.credit?.reason).toBe('Damaged')
      expect(doc.credit?.disposition).toMatch(/Available as credit/i)
      expect(doc.credit?.returnedLines[0]).toMatchObject({
        name: 'Takis Fuego',
        quantity: 1,
        disposition: 'Written off — damaged',
      })
      expect(doc.total).toBe(result.creditTotal)
      expect(doc.taxTotal).not.toBe('0.00')
    })

    it('says plainly when the credit was applied, and to what', async () => {
      const sale = await sell(4)
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'APPLY_TO_BALANCE',
        idempotencyKey: randomUUID(),
      })

      const doc = await getCreditDocument(office.ctx, result.creditMemoId!)
      expect(doc.credit?.disposition).toMatch(/^Applied to S-/)
      expect(doc.credit?.remaining).toBe('0.00')
    })

    it('says plainly when it was refunded', async () => {
      const sale = await sell(2, '41.83')
      const item = await firstSaleItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
        financialAction: 'REFUND',
        refund: { method: 'CHECK', referenceNumber: '8812' },
        idempotencyKey: randomUUID(),
      })

      const doc = await getCreditDocument(office.ctx, result.creditMemoId!)
      expect(doc.credit?.disposition).toMatch(/Refunded by check/i)
      expect(doc.payments[0]).toMatchObject({ method: 'CHECK', reference: '8812' })
    })

    it('renders as a full page and a thermal roll', async () => {
      const { result } = await issue()
      const doc = await getCreditDocument(office.ctx, result.creditMemoId!)

      for (const layout of ['full', 'thermal'] as const) {
        const bytes = await renderReceiptPdf(doc, layout)
        expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-')
        expect(bytes.byteLength).toBeGreaterThan(500)
      }
    })

    it('opens for whoever holds a share link, and nothing else', async () => {
      const { result } = await issue()
      const { token } = await createShareLink(office.ctx, {
        kind: 'creditMemo',
        creditMemoId: result.creditMemoId!,
      })

      const resolved = await resolveShareToken(token)
      expect(resolved?.target).toEqual({ kind: 'creditMemo', creditMemoId: result.creditMemoId })

      const doc = await getPublicCreditDocument(resolved!.organizationId, result.creditMemoId!)
      expect(doc.receiptNumber).toMatch(/^CM-/)
      expect(await resolveShareToken('not-a-real-token-at-all-0000')).toBeNull()
    })

    it('emails with the PDF attached and logs it against the credit', async () => {
      const email = new FakeEmail()
      setProvidersForTesting({ email })
      try {
        const { result } = await issue()
        const sent = await emailReceipt(office.ctx, {
          document: { kind: 'creditMemo', id: result.creditMemoId! },
          to: 'orders@store.test',
        })

        expect(sent.status).toBe('SENT')
        expect(email.sent[0].attachments?.[0].contentType).toBe('application/pdf')

        const [log] = await listDeliveries(office.ctx, {
          kind: 'creditMemo',
          id: result.creditMemoId!,
        })
        expect(log).toMatchObject({ channel: 'EMAIL', status: 'SENT' })
      } finally {
        resetProviders()
      }
    })

    it('shows the void to somebody holding a link issued before it', async () => {
      const { result } = await issue()
      await voidReturn(office.ctx, result.returnId, 'Entered twice')

      const doc = await getCreditDocument(office.ctx, result.creditMemoId!)
      expect(doc.status).toBe('VOIDED')
      expect(doc.credit?.disposition).toMatch(/no longer applies/i)
      expect(doc.void?.reason).toBe('Entered twice')
    })

    it('reads the store as it was, not as it is now', async () => {
      const { result } = await issue()
      await db(org.ownerCtx).customer.update({
        where: { id: customerId },
        data: { name: 'Sold To Somebody Else LLC' },
      })

      const doc = await getCreditDocument(office.ctx, result.creditMemoId!)
      expect(doc.headerFromSnapshot).toBe(true)
      expect(doc.billTo.name).toBe("Joe's Marathon")
    })
  })

  // ── §11 the account timeline ──────────────────────────────────────────────

  describe('the account timeline', () => {
    it('puts invoices, payments, returns, credits and refunds on one list', async () => {
      const sale = await sell(3, '20.00')
      const item = await firstSaleItem(sale.saleId)
      await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
        financialAction: 'REFUND',
        refund: { method: 'CASH' },
        idempotencyKey: randomUUID(),
      })

      const { getAccountLedger } = await import('@/server/services/accountLedger.service')
      const ledger = await getAccountLedger(org.ownerCtx, customerId)
      const kinds = new Set(ledger.entries.map((e) => e.kind))

      expect(kinds).toEqual(new Set(['INVOICE', 'PAYMENT', 'RETURN', 'CREDIT', 'REFUND']))
      // Newest first.
      const times = ledger.entries.map((e) => e.occurredAt)
      expect([...times].sort().reverse()).toEqual(times)
    })

    it('shows open invoices and held credit separately', async () => {
      const paid = await sell(2, '41.83')
      await sell(3)
      const item = await firstSaleItem(paid.saleId)
      await createReturn(office.ctx, {
        saleId: paid.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      const { getAccountLedger } = await import('@/server/services/accountLedger.service')
      const ledger = await getAccountLedger(org.ownerCtx, customerId)

      expect(Number(ledger.position.openInvoices)).toBeGreaterThan(0)
      expect(Number(ledger.position.memoCredit)).toBeGreaterThan(0)
      expect(Number(ledger.position.net)).toBeCloseTo(
        Number(ledger.position.openInvoices) - Number(ledger.position.totalCredit),
        2,
      )
    })
  })

  // ── §20 reconciliation ────────────────────────────────────────────────────

  describe('reconciliation', () => {
    it('keeps the credit memo identity: amount = applied + refunded + remaining', async () => {
      const paid = await sell(4, '83.66')
      const item = await firstSaleItem(paid.saleId)

      const result = await createReturn(office.ctx, {
        saleId: paid.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 4, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      await issueRefund(office.ctx, {
        creditMemoId: result.creditMemoId!,
        amount: '20.00',
        method: 'CASH',
        idempotencyKey: randomUUID(),
      })
      await sell(1)
      await applyCreditMemo(office.ctx, { creditMemoId: result.creditMemoId! })

      const memo = await db(org.ownerCtx).creditMemo.findFirstOrThrow({
        where: { id: result.creditMemoId! },
        select: {
          amount: true, remainingAmount: true, refundedAmount: true,
          applications: { where: { status: 'APPLIED' }, select: { amount: true } },
        },
      })

      const applied = memo.applications.reduce((n, a) => n + toNumber(a.amount), 0)
      expect(applied + toNumber(memo.refundedAmount) + toNumber(memo.remainingAmount)).toBeCloseTo(
        toNumber(memo.amount),
        2,
      )
    })

    it('keeps AR equal to invoices less payment and credit allocations', async () => {
      const a = await sell(3)
      const b = await sell(2)
      const item = await firstSaleItem(a.saleId)

      await recordPayment(office.ctx, {
        customerId, method: 'CASH', amount: '30.00',
        strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
      })
      await createReturn(office.ctx, {
        saleId: a.saleId,
        reason: 'UNSOLD',
        lines: [{ saleItemId: item.id, quantity: 1, disposition: 'RESTOCK_TRUCK' }],
        financialAction: 'APPLY_TO_BALANCE',
        idempotencyKey: randomUUID(),
      })

      const sales = await db(org.ownerCtx).sale.findMany({
        where: { status: 'COMPLETED' },
        select: { id: true, total: true, amountPaid: true, creditsApplied: true, balanceDue: true },
      })

      for (const sale of sales) {
        // The invoice identity, per document.
        expect(
          toNumber(sale.total) - toNumber(sale.amountPaid) - toNumber(sale.creditsApplied),
        ).toBeCloseTo(toNumber(sale.balanceDue), 2)
      }

      const openSum = sales.reduce((n, s) => n + Math.max(0, toNumber(s.balanceDue)), 0)
      const position = await getCreditPosition(org.ownerCtx, customerId)
      expect(Number(position.openInvoices)).toBeCloseTo(openSum, 2)
      expect(b.saleId).toBeTruthy()
    })

    it('keeps inventory equal to sale out less sellable return in', async () => {
      const sale = await sell(5)
      const item = await firstSaleItem(sale.saleId)

      await createReturn(office.ctx, {
        saleId: sale.saleId,
        reason: 'OTHER',
        lines: [
          { saleItemId: item.id, quantity: 2, disposition: 'RESTOCK_TRUCK' },
          { saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' },
        ],
        financialAction: 'ACCOUNT_CREDIT',
        idempotencyKey: randomUUID(),
      })

      // Loaded 480, sold 60, put 24 back on the truck. The damaged case is held
      // elsewhere and must not show up here.
      expect(await balanceOf(truckLocation, product.id)).toBe(480 - 60 + 24)
      expect(await holdBalance('DAMAGED_HOLD')).toBe(12)
      expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
    })
  })
})

/** Records what it was handed, so a test can look at the outgoing message. */
class FakeEmail implements EmailProvider {
  readonly name = 'fake-email'
  sent: EmailMessage[] = []

  async send(message: EmailMessage) {
    this.sent.push(message)
    return { ok: true as const, messageId: 'fake-1' }
  }
}

function dayString(offset: number): string {
  return new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
}

function rowFor(rows: ReportRow[], label: string) {
  return rows.find((r) => r.label === label)
}

function toNumber(value: unknown): number {
  return Number(String(value))
}

function toAmount(value: unknown): string {
  return Number(String(value)).toFixed(2)
}
