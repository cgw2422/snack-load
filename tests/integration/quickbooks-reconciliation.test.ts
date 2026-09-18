import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout } from '@/server/services/sale.service'
import { recordPayment, reversePayment } from '@/server/services/payment.service'
import { createReturn } from '@/server/services/return.service'
import { applyCreditMemo, getCreditPosition, issueRefund, unapplyCreditMemo } from '@/server/services/credit.service'
import { describePaymentSync, listSplitPayments } from '@/server/services/integration.service'
import { m, toAmountString } from '@/server/domain/money'
import type { FakeQuickBooks } from '@/server/integrations/quickbooks/fake'
import type { QboInvoice, QboPayment, QboCreditMemo } from '@/server/integrations/quickbooks/types'
import { addMember, createCustomer, createProduct, createTestOrg, type TestOrg } from '../helpers'
import { connectQuickBooks, disconnectFake, runSync } from '../helpers/quickbooks'

/**
 * End-to-end accounting reconciliation (spec §22) and split payments (§11–13).
 *
 * The question both halves answer is the same one: after every transition, do
 * the two systems agree about what this customer owes — and is every penny
 * collected accounted for somewhere?
 */
describe('QuickBooks accounting reconciliation', () => {
  let org: TestOrg
  let runner: Awaited<ReturnType<typeof addMember>>
  let office: Awaited<ReturnType<typeof addMember>>
  let qbo: FakeQuickBooks
  let customerId: string
  let product: Awaited<ReturnType<typeof createProduct>>

  beforeEach(async () => {
    org = await createTestOrg()
    runner = await addMember(org, 'runner', { firstName: 'Mike', lastName: 'Donnelly' })
    office = await addMember(org, 'office', { firstName: 'Pat', lastName: 'Sandoval' })

    const customer = await createCustomer(org.organizationId)
    customerId = customer.id

    // No tax, so the arithmetic in this suite is the arithmetic in the spec.
    product = await createProduct(org.organizationId, {
      name: 'Takis Fuego', unitsPerCase: 10, casePrice: '20.00', costPerBaseUnit: '1.000000',
      taxable: false,
    })
    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 300, unitCost: '10.00' }],
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
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 250 }],
    })

    qbo = await connectQuickBooks(org)
  })

  afterEach(async () => {
    disconnectFake()
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  const sell = (cases: number, paid?: string) =>
    checkout(runner.ctx, {
      customerId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: cases }],
      ...(paid ? { payment: { method: 'CASH' as const, amount: paid } } : {}),
    })

  const saleRow = (saleId: string) => db(org.ownerCtx).sale.findUniqueOrThrow({ where: { id: saleId } })
  const firstItem = (saleId: string) => db(org.ownerCtx).saleItem.findFirstOrThrow({ where: { saleId } })
  const invoices = () => qbo.allOf<QboInvoice>('Invoice')
  const payments = () => qbo.allOf<QboPayment>('Payment')

  /**
   * What QuickBooks thinks this invoice still owes.
   *
   * A void zeroes it; otherwise it is the invoice less every live payment line
   * linked to it — cash payments and credit applications alike, since a credit
   * application is a zero-total payment carrying a link.
   */
  function quickBooksBalance(invoiceId: string): string {
    const invoice = invoices().find((entry) => entry.Id === invoiceId)!
    if (invoice.void) return '0.00'

    const settled = payments()
      .filter((payment) => !payment.void)
      .flatMap((payment) => payment.Line ?? [])
      .filter((line) => line.LinkedTxn.some((txn) => txn.TxnId === invoiceId))
      .reduce((total, line) => total.plus(m(line.Amount)), m(0))

    return toAmountString(m(invoice.TotalAmt ?? 0).minus(settled))
  }

  /** Credit QuickBooks still has available: memos less what has been applied. */
  function quickBooksAvailableCredit(): string {
    const issued = qbo
      .allOf<QboCreditMemo>('CreditMemo')
      .reduce((total, memo) => total.plus(m(memo.TotalAmt ?? 0)), m(0))

    const consumed = payments()
      .filter((payment) => !payment.void)
      .flatMap((payment) => payment.Line ?? [])
      .filter((line) => line.LinkedTxn.some((txn) => txn.TxnType === 'CreditMemo'))
      .reduce((total, line) => total.plus(m(line.Amount)), m(0))

    return toAmountString(issued.minus(consumed))
  }

  // ── §22 the full walk ─────────────────────────────────────────────────────

  it('keeps both systems in step through payment, credit, reversal and reapplication', async () => {
    // Invoice $500.
    const sale = await sell(25)
    await runSync(org, qbo)
    const row = await saleRow(sale.saleId)
    expect(toAmountString(row.total)).toBe('500.00')
    const invoiceId = invoices()[0].Id!

    const check = async (label: string, expected: { outstanding: string; credit: string }) => {
      const local = await saleRow(sale.saleId)
      const position = await getCreditPosition(office.ctx, customerId)

      expect(toAmountString(local.balanceDue), `${label}: SnackLoad outstanding`).toBe(expected.outstanding)
      expect(position.memoCredit, `${label}: SnackLoad available credit`).toBe(expected.credit)
      expect(quickBooksBalance(invoiceId), `${label}: QuickBooks outstanding`).toBe(expected.outstanding)
      expect(quickBooksAvailableCredit(), `${label}: QuickBooks available credit`).toBe(expected.credit)

      // And no duplicates of anything, at any point in the walk.
      expect(qbo.countOf('Invoice'), `${label}: invoices`).toBe(1)
      expect(qbo.countOf('CreditMemo'), `${label}: credit memos`).toBeLessThanOrEqual(1)
    }

    await check('after the invoice', { outstanding: '500.00', credit: '0.00' })

    // Payment $200 → outstanding $300.
    const payment = await recordPayment(office.ctx, {
      customerId, method: 'CASH', amount: '200.00',
      strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)
    await check('after the payment', { outstanding: '300.00', credit: '0.00' })

    // Return $100, credit applied → outstanding $200.
    const item = await firstItem(sale.saleId)
    const result = await createReturn(office.ctx, {
      saleId: sale.saleId,
      reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 5, disposition: 'DAMAGED' }],
      financialAction: 'APPLY_TO_BALANCE',
      idempotencyKey: randomUUID(),
    })
    expect(result.creditTotal).toBe('100.00')
    await runSync(org, qbo)
    await check('after the credit is applied', { outstanding: '200.00', credit: '0.00' })

    // Reverse the payment → outstanding $400.
    await reversePayment(office.ctx, payment.paymentId, 'Cheque bounced')
    await runSync(org, qbo)
    await check('after the payment is reversed', { outstanding: '400.00', credit: '0.00' })

    // Unapply the credit → outstanding $500, credit $100 available.
    await unapplyCreditMemo(office.ctx, result.creditMemoId!)
    await runSync(org, qbo)
    await check('after the credit is unapplied', { outstanding: '500.00', credit: '100.00' })

    // Reapply it → outstanding $400 again.
    await applyCreditMemo(office.ctx, { creditMemoId: result.creditMemoId! })
    await runSync(org, qbo)
    await check('after the credit is reapplied', { outstanding: '400.00', credit: '0.00' })

    // No duplicated cash: exactly one cash payment object ever existed, and it
    // is voided. (A voided payment reads as zero, so it is identified by having
    // no credit-memo link rather than by its amount.)
    const isApplication = (entry: QboPayment) =>
      entry.Line?.some((line) => line.LinkedTxn.some((txn) => txn.TxnType === 'CreditMemo')) ?? false
    const cash = payments().filter((entry) => !isApplication(entry))
    expect(cash).toHaveLength(1)
    expect(cash[0].void).toBe(true)

    // No duplicated credit: one memo, one live application.
    expect(qbo.countOf('CreditMemo')).toBe(1)
    const liveApplications = payments().filter((entry) => !entry.void && isApplication(entry))
    expect(liveApplications).toHaveLength(1)
    // Applied once, unapplied, applied again: two application objects, one live.
    expect(payments().filter(isApplication)).toHaveLength(2)

    // No duplicated revenue: one invoice, at its original value.
    expect(invoices()).toHaveLength(1)
    expect(invoices()[0].TotalAmt).toBe(500)
  })

  it('refunds the remaining credit and leaves both systems at zero credit', async () => {
    const sale = await sell(25)
    await runSync(org, qbo)
    const item = await firstItem(sale.saleId)

    const result = await createReturn(office.ctx, {
      saleId: sale.saleId,
      reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 5, disposition: 'DAMAGED' }],
      financialAction: 'ACCOUNT_CREDIT',
      idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)
    expect((await getCreditPosition(office.ctx, customerId)).memoCredit).toBe('100.00')
    expect(quickBooksAvailableCredit()).toBe('100.00')

    await issueRefund(office.ctx, {
      creditMemoId: result.creditMemoId!,
      amount: '100.00',
      method: 'CHECK',
      referenceNumber: '2291',
      idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)

    expect((await getCreditPosition(office.ctx, customerId)).memoCredit).toBe('0.00')
    expect(quickBooksAvailableCredit()).toBe('0.00')
    expect(qbo.countOf('RefundReceipt')).toBe(1)
    // The refund moved cash once.
    expect(qbo.allOf<{ TotalAmt: number }>('RefundReceipt')[0].TotalAmt).toBe(100)
  })

  // ── §11–13 split payments ─────────────────────────────────────────────────

  describe('a collection split across an invoice and a sales receipt', () => {
    /**
     * The scenario, built the way SnackLoad actually reaches it.
     *
     * A counter sale posts as a sales receipt with its own payment. That
     * payment is later reversed — a bounced cheque, a miscount — which leaves
     * the receipt owing money. A single later collection then settles both that
     * receipt and an open invoice, which is the case where one SnackLoad
     * payment spans two document types.
     */
    async function splitCollection() {
      const invoiceSale = await sell(10) // $200 on account
      const counterSale = await sell(5, '100.00') // $100 at the counter
      await runSync(org, qbo)

      expect((await saleRow(counterSale.saleId)).documentType).toBe('SALES_RECEIPT')
      expect(qbo.countOf('SalesReceipt')).toBe(1)
      expect(qbo.countOf('Invoice')).toBe(1)

      // The counter payment bounces, leaving the receipt owing its $100.
      const counterPayment = await db(org.ownerCtx).payment.findFirstOrThrow({
        where: { allocations: { some: { saleId: counterSale.saleId } } },
      })
      await reversePayment(office.ctx, counterPayment.id, 'Cheque returned')
      await runSync(org, qbo)
      expect(toAmountString((await saleRow(counterSale.saleId)).balanceDue)).toBe('100.00')

      // One collection of $300 settles both.
      const collection = await recordPayment(office.ctx, {
        customerId,
        method: 'CASH',
        amount: '300.00',
        strategy: 'OLDEST_FIRST',
        idempotencyKey: randomUUID(),
      })
      await runSync(org, qbo)

      return { collection, invoiceSale, counterSale }
    }

    it('sends only the invoice portion, and says why the rest is missing', async () => {
      const { collection, invoiceSale, counterSale } = await splitCollection()

      const reconciliation = await describePaymentSync(office.ctx, collection.paymentId)
      expect(reconciliation).not.toBeNull()

      // Every penny is accounted for.
      expect(reconciliation!.collected).toBe('300.00')
      expect(reconciliation!.balanced).toBe(true)
      expect(reconciliation!.unaccounted).toBe('0.00')

      const invoicePart = reconciliation!.components.find((c) => c.representation === 'INVOICE_PAYMENT')
      const receiptPart = reconciliation!.components.find((c) => c.representation === 'SALES_RECEIPT')
      expect(invoicePart?.amount).toBe('200.00')
      expect(receiptPart?.amount).toBe('100.00')
      expect(reconciliation!.inQuickBooks).toBe('200.00')

      // And it is explained in words a support person can read.
      expect(receiptPart?.explanation).toMatch(/already records the money in QuickBooks/i)
      expect(receiptPart?.explanation).toContain(
        (await saleRow(counterSale.saleId)).saleNumber,
      )
      expect(invoicePart?.explanation).toContain((await saleRow(invoiceSale.saleId)).saleNumber)
    })

    it('creates no duplicate cash and no duplicate revenue', async () => {
      await splitCollection()

      // One sales receipt, one invoice, and exactly one live payment for the
      // invoice portion. No second QuickBooks payment was invented for the
      // counter money.
      expect(qbo.countOf('SalesReceipt')).toBe(1)
      expect(qbo.countOf('Invoice')).toBe(1)

      const live = payments().filter((entry) => !entry.void && Number(entry.TotalAmt) > 0)
      expect(live).toHaveLength(1)
      expect(live[0].TotalAmt).toBe(200)
      expect(live[0].Line).toHaveLength(1)
    })

    it('reconciles the monetary total without raising a mismatch', async () => {
      const { collection } = await splitCollection()

      const job = await db(org.ownerCtx).syncJob.findFirstOrThrow({
        where: { entityType: 'Payment', localId: collection.paymentId, operation: 'CREATE' },
      })
      // $300 here, $200 there, and no AMOUNT_MISMATCH — because the expected
      // total is what QuickBooks is meant to hold, not the whole collection.
      expect(job.status).toBe('SYNCED')
      expect(job.errorCategory).toBeNull()
    })

    it('lists it for an administrator', async () => {
      const { collection } = await splitCollection()

      const listed = await listSplitPayments(office.ctx)
      const entry = listed.find((row) => row.paymentId === collection.paymentId)
      expect(entry).toBeDefined()
      expect(entry!.collected).toBe('300.00')
      expect(entry!.inQuickBooks).toBe('200.00')
      expect(entry!.balanced).toBe(true)
    })

    it('accounts for money left unapplied on the account', async () => {
      await sell(10) // $200 on account
      await runSync(org, qbo)

      // The store pays $250 against a $200 invoice; $50 stays on account.
      const over = await recordPayment(office.ctx, {
        customerId, method: 'CASH', amount: '250.00',
        strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
      })
      await runSync(org, qbo)

      const reconciliation = await describePaymentSync(office.ctx, over.paymentId)
      expect(reconciliation!.balanced).toBe(true)
      expect(reconciliation!.collected).toBe('250.00')

      const unapplied = reconciliation!.components.find((c) => c.representation === 'UNAPPLIED')
      expect(unapplied?.amount).toBe('50.00')
      expect(unapplied?.explanation).toMatch(/holds credit on a customer account/i)

      // QuickBooks carries the whole $250: $200 linked, $50 unapplied — which
      // is how QuickBooks itself represents credit on an account.
      expect(reconciliation!.inQuickBooks).toBe('250.00')
      expect(payments().find((entry) => !entry.void)!.TotalAmt).toBe(250)
    })

    it('does not send a payment at all when every penny is already on a receipt', async () => {
      const sale = await sell(5, '100.00')
      await runSync(org, qbo)

      expect((await saleRow(sale.saleId)).documentType).toBe('SALES_RECEIPT')
      // The receipt banked it; a payment as well would be the money twice.
      expect(qbo.countOf('Payment')).toBe(0)

      const counterPayment = await db(org.ownerCtx).payment.findFirstOrThrow({
        where: { allocations: { some: { saleId: sale.saleId } } },
      })
      const reconciliation = await describePaymentSync(office.ctx, counterPayment.id)
      expect(reconciliation!.balanced).toBe(true)
      expect(reconciliation!.inQuickBooks).toBe('0.00')
      expect(reconciliation!.components).toHaveLength(1)
      expect(reconciliation!.components[0].representation).toBe('SALES_RECEIPT')
    })
  })
})
