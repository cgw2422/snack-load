import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout, voidSale } from '@/server/services/sale.service'
import { recordPayment, reversePayment } from '@/server/services/payment.service'
import { createReturn, voidReturn } from '@/server/services/return.service'
import {
  applyCreditMemo,
  createAdjustmentCredit,
  getCreditPosition,
  issueRefund,
  unapplyCreditMemo,
  voidCreditMemo,
  voidRefund,
} from '@/server/services/credit.service'
import { postCogsBatch, prepareCogsBatch, voidCogsBatch } from '@/server/services/cogs.service'
import { localDateString } from '@/lib/dates'
import { m, toAmountString } from '@/server/domain/money'
import type { FakeQuickBooks } from '@/server/integrations/quickbooks/fake'
import type {
  QboCreditMemo,
  QboInvoice,
  QboJournalEntry,
  QboPayment,
  QboRefundReceipt,
  QboSalesReceipt,
} from '@/server/integrations/quickbooks/types'
import { addMember, createCustomer, createProduct, createTestOrg, type TestOrg } from '../helpers'
import { connectQuickBooks, disconnectFake, jobsFor, mappingFor, runSync } from '../helpers/quickbooks'

/**
 * Voids and reversals reaching QuickBooks (docs/08 §18).
 *
 * SnackLoad never deletes financial history; it voids and reverses. This suite
 * proves the accounting copy follows — with the right operation for each
 * object, since QuickBooks does not offer the same verb for all of them.
 */
describe('QuickBooks voids and reversals', () => {
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

    const taxRate = await db(org.ownerCtx).taxRate.create({
      data: {
        organizationId: org.organizationId,
        name: 'Ohio 7.25%', rate: '0.0725', code: 'OH-STATE', jurisdiction: 'Ohio', isDefault: true,
      },
      select: { id: true },
    })
    const customer = await createCustomer(org.organizationId)
    customerId = customer.id
    await db(org.ownerCtx).customer.update({ where: { id: customerId }, data: { taxRateId: taxRate.id } })

    product = await createProduct(org.organizationId, {
      name: 'Takis Fuego', unitsPerCase: 12, casePrice: '20.00', costPerBaseUnit: '1.200000',
    })
    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 200, unitCost: '14.40' }],
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
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 150 }],
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

  const jobOf = async (entityType: string, operation: string, localId?: string) =>
    (await jobsFor(org)).find(
      (job) =>
        job.entityType === entityType &&
        job.operation === operation &&
        (!localId || job.localId === localId),
    )

  // ── §3 sale void, both document types ─────────────────────────────────────

  it('voids the QuickBooks Invoice when an on-account sale is voided', async () => {
    const sale = await sell(4)
    await runSync(org, qbo)
    const [invoice] = invoices()
    expect(invoice.TotalAmt).toBe(85.8)

    await voidSale(office.ctx, sale.saleId, 'Delivered to the wrong store')
    await runSync(org, qbo)

    // The document is still there. QuickBooks voids by keeping and zeroing,
    // which is the same rule SnackLoad follows locally.
    expect(qbo.countOf('Invoice')).toBe(1)
    const [after] = invoices()
    expect(after.Id).toBe(invoice.Id)
    expect(after.void).toBe(true)
    expect(after.TotalAmt).toBe(0)
    // No receivable left active on either side.
    expect(after.Balance).toBe(0)
    expect(toAmountString((await saleRow(sale.saleId)).balanceDue)).toBe('0.00')

    const job = await jobOf('Sale', 'VOID', sale.saleId)
    expect(job?.status).toBe('SYNCED')
  })

  it('voids the QuickBooks SalesReceipt when a counter sale is voided', async () => {
    const sale = await sell(3, '64.35')
    await runSync(org, qbo)
    expect(qbo.countOf('SalesReceipt')).toBe(1)

    await voidSale(office.ctx, sale.saleId, 'Rung up twice')
    await runSync(org, qbo)

    const [receipt] = qbo.allOf<QboSalesReceipt>('SalesReceipt')
    expect(receipt.void).toBe(true)
    expect(receipt.TotalAmt).toBe(0)
    expect(qbo.countOf('SalesReceipt')).toBe(1)
  })

  it('never creates a document that was voided before the first sync', async () => {
    const sale = await sell(2)
    // No sync yet — the runner corrected it at the stop.
    await voidSale(office.ctx, sale.saleId, 'Wrong store')
    await runSync(org, qbo)

    // Nothing was created, and so nothing needed voiding.
    expect(qbo.countOf('Invoice')).toBe(0)
    expect(await mappingFor(org, 'Sale', sale.saleId)).toBeNull()

    const create = await jobOf('Sale', 'CREATE', sale.saleId)
    const cancel = await jobOf('Sale', 'VOID', sale.saleId)
    expect(create?.status).toBe('SYNCED')
    expect(cancel?.status).toBe('SYNCED')

    const log = await db(org.ownerCtx).syncLog.findFirst({
      where: { syncJobId: cancel!.id },
      orderBy: { createdAt: 'desc' },
    })
    expect(log?.message).toMatch(/never reached QuickBooks/i)
  })

  it('raises an issue rather than working around a QuickBooks refusal', async () => {
    const sale = await sell(4)
    await runSync(org, qbo)

    // QuickBooks refuses to void a document that other transactions depend on.
    qbo.failAlways('voidInvoice', {
      kind: 'validation',
      message: 'You cannot void this invoice because it has payments applied to it.',
      code: '6000',
    })
    await voidSale(office.ctx, sale.saleId, 'Duplicate')
    await runSync(org, qbo)

    const job = await jobOf('Sale', 'VOID', sale.saleId)
    expect(job?.status).toBe('NEEDS_ATTENTION')
    expect(job?.errorCategory).toBe('VALIDATION')
    expect(job?.lastError).toMatch(/payments applied/i)

    // Nothing was deleted to force the void through.
    expect(qbo.countOf('Invoice')).toBe(1)
    expect(invoices()[0].void).toBeUndefined()
  })

  // ── §4 payment reversal ───────────────────────────────────────────────────

  it('voids the QuickBooks Payment so the invoice balance comes back', async () => {
    // Invoice $500-ish, payment $200.
    const sale = await sell(25)
    await runSync(org, qbo)
    const total = toAmountString((await saleRow(sale.saleId)).total)

    const payment = await recordPayment(office.ctx, {
      customerId, method: 'CASH', amount: '200.00',
      strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)
    expect(payments()).toHaveLength(1)
    expect(payments()[0].TotalAmt).toBe(200)

    await reversePayment(office.ctx, payment.paymentId, 'Cheque bounced')
    await runSync(org, qbo)

    // Voided, not answered with a second negative payment: the money moved
    // once, so QuickBooks should show one cash row, reversed.
    expect(qbo.countOf('Payment')).toBe(1)
    const [reversed] = payments()
    expect(reversed.void).toBe(true)
    expect(reversed.TotalAmt).toBe(0)

    // The receivable is open again in both systems.
    expect(toAmountString((await saleRow(sale.saleId)).balanceDue)).toBe(total)
  })

  // ── §7 unapplying a credit is NOT voiding it ──────────────────────────────

  it('unapplies a credit without touching the credit memo', async () => {
    const sale = await sell(25)
    await runSync(org, qbo)
    const total = toAmountString((await saleRow(sale.saleId)).total)
    const item = await firstItem(sale.saleId)

    const result = await createReturn(office.ctx, {
      saleId: sale.saleId,
      reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 5, disposition: 'DAMAGED' }],
      financialAction: 'APPLY_TO_BALANCE',
      idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)

    expect(qbo.countOf('CreditMemo')).toBe(1)
    const creditTotal = result.creditTotal
    const application = payments().find((entry) => entry.TotalAmt === 0)
    expect(application).toBeDefined()
    expect(toAmountString((await saleRow(sale.saleId)).balanceDue)).toBe(
      toAmountString(m(total).minus(creditTotal)),
    )

    await unapplyCreditMemo(office.ctx, result.creditMemoId!)
    await runSync(org, qbo)

    // The application is reversed; the credit memo itself is untouched and
    // available again. Confusing the two is how the balances diverge.
    const [memo] = qbo.allOf<QboCreditMemo>('CreditMemo')
    expect(toAmountString(memo.TotalAmt!)).toBe(creditTotal)
    expect(memo.void).toBeUndefined()

    const link = payments().find((entry) => entry.Id === application!.Id)!
    expect(link.void).toBe(true)

    expect(toAmountString((await saleRow(sale.saleId)).balanceDue)).toBe(total)
    expect((await getCreditPosition(office.ctx, customerId)).memoCredit).toBe(creditTotal)
  })

  // ── §5 credit memo void ───────────────────────────────────────────────────

  it('reduces the QuickBooks credit memo to nothing, since it cannot be voided', async () => {
    // A credit raised against a sale, then detached from its return so it can
    // be voided directly — SnackLoad sends a return's credit back through the
    // return, and this is the standalone path.
    const sale = await sell(4)
    await runSync(org, qbo)
    const item = await firstItem(sale.saleId)
    const result = await createReturn(office.ctx, {
      saleId: sale.saleId, reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 2, disposition: 'DAMAGED' }],
      financialAction: 'ACCOUNT_CREDIT', idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)
    expect(qbo.allOf<QboCreditMemo>('CreditMemo')[0].TotalAmt).toBeGreaterThan(0)

    await db(org.ownerCtx).return.update({
      where: { id: result.returnId },
      data: { creditMemoId: null },
    })
    await voidCreditMemo(office.ctx, result.creditMemoId!, 'Approved in error')
    await runSync(org, qbo)

    // QuickBooks has no void for a credit memo and only offers delete, which
    // would remove the record. It is zeroed and marked instead.
    expect(qbo.countOf('CreditMemo')).toBe(1)
    const [memo] = qbo.allOf<QboCreditMemo>('CreditMemo')
    expect(memo.TotalAmt).toBe(0)
    expect(memo.PrivateNote).toMatch(/VOIDED IN SNACKLOAD: Approved in error/)
    expect(memo.Line.every((line) => line.Amount === 0)).toBe(true)

    expect((await getCreditPosition(office.ctx, customerId)).memoCredit).toBe('0.00')
  })

  it('refuses locally to void a credit that is applied, and says what to do', async () => {
    const sale = await sell(25)
    await runSync(org, qbo)
    const item = await firstItem(sale.saleId)
    const result = await createReturn(office.ctx, {
      saleId: sale.saleId, reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 5, disposition: 'DAMAGED' }],
      financialAction: 'APPLY_TO_BALANCE', idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)
    await db(org.ownerCtx).return.update({
      where: { id: result.returnId },
      data: { creditMemoId: null },
    })

    // The dependent state is handled explicitly, and by refusing — which is
    // what stops a phantom credit or an application to a credit that is gone.
    await expect(voidCreditMemo(office.ctx, result.creditMemoId!, 'Mistake')).rejects.toThrow(
      /applied to an invoice\. Unapply it first/i,
    )

    // Unapply, then void. Both systems end up in the same place.
    await unapplyCreditMemo(office.ctx, result.creditMemoId!)
    await voidCreditMemo(office.ctx, result.creditMemoId!, 'Mistake')
    await runSync(org, qbo)

    const [memo] = qbo.allOf<QboCreditMemo>('CreditMemo')
    expect(memo.TotalAmt).toBe(0)
    const link = payments().find((entry) => entry.Line?.[0]?.LinkedTxn?.length)
    expect(link?.void).toBe(true)
    expect(toAmountString((await saleRow(sale.saleId)).balanceDue)).toBe(
      toAmountString((await saleRow(sale.saleId)).total),
    )
  })

  // ── §6 refund void ────────────────────────────────────────────────────────

  it('reduces the QuickBooks refund receipt to nothing and gives the credit back', async () => {
    const sale = await sell(4, '85.80')
    await runSync(org, qbo)
    const item = await firstItem(sale.saleId)

    const result = await createReturn(office.ctx, {
      saleId: sale.saleId,
      reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 2, disposition: 'DAMAGED' }],
      financialAction: 'REFUND',
      refund: { method: 'CASH' },
      idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)
    expect(qbo.countOf('RefundReceipt')).toBe(1)

    const refund = await db(org.ownerCtx).refund.findFirstOrThrow({
      where: { creditMemoId: result.creditMemoId! },
    })
    await voidRefund(office.ctx, refund.id, 'Cash was never handed over')
    await runSync(org, qbo)

    const [receipt] = qbo.allOf<QboRefundReceipt>('RefundReceipt')
    expect(receipt.TotalAmt).toBe(0)
    expect(receipt.PrivateNote).toMatch(/VOIDED IN SNACKLOAD/)
    expect(qbo.countOf('RefundReceipt')).toBe(1)

    // The credit is available again on both sides.
    expect((await getCreditPosition(office.ctx, customerId)).memoCredit).toBe(result.creditTotal)
  })

  // ── return void reaches QuickBooks through its credit ──────────────────────

  it('reverses a voided return through its credit memo, not through the return', async () => {
    const sale = await sell(4)
    await runSync(org, qbo)
    const item = await firstItem(sale.saleId)

    const result = await createReturn(office.ctx, {
      saleId: sale.saleId,
      reason: 'UNSOLD',
      lines: [{ saleItemId: item.id, quantity: 2, disposition: 'RESTOCK_TRUCK' }],
      financialAction: 'ACCOUNT_CREDIT',
      idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)
    expect(qbo.allOf<QboCreditMemo>('CreditMemo')[0].TotalAmt).toBeGreaterThan(0)

    await voidReturn(office.ctx, result.returnId, 'Logged against the wrong store')
    await runSync(org, qbo)

    const [memo] = qbo.allOf<QboCreditMemo>('CreditMemo')
    expect(memo.TotalAmt).toBe(0)

    // The goods document still has no QuickBooks object of its own.
    const jobs = await jobsFor(org)
    expect(jobs.some((job) => job.entityType === 'Return')).toBe(false)
  })

  // ── COGS journal ──────────────────────────────────────────────────────────

  it('reverses a COGS journal with an opposite entry rather than deleting it', async () => {
    await sell(10)
    await runSync(org, qbo)

    const today = localDateString(new Date(), org.ownerCtx.organization.timezone)
    const batch = await prepareCogsBatch(office.ctx, { from: today, to: today })
    await postCogsBatch(office.ctx, batch.id)
    await runSync(org, qbo)
    expect(qbo.countOf('JournalEntry')).toBe(1)

    await voidCogsBatch(office.ctx, batch.id, 'Period reopened')
    await runSync(org, qbo)

    // Two entries, netting to nothing, both readable.
    expect(qbo.countOf('JournalEntry')).toBe(2)
    const entries = qbo.allOf<QboJournalEntry>('JournalEntry')
    const [forward, reversal] = entries
    const debit = (entry: QboJournalEntry) =>
      entry.Line.find((line) => line.JournalEntryLineDetail.PostingType === 'Debit')!

    expect(debit(forward).JournalEntryLineDetail.AccountRef.value).toBe('5')
    // The reversal debits inventory and credits COGS: the mirror image.
    expect(debit(reversal).JournalEntryLineDetail.AccountRef.value).toBe('6')
    expect(debit(reversal).Amount).toBe(debit(forward).Amount)
    expect(reversal.PrivateNote).toContain(batch.id)

    // The mapping still names the original: the reversal is a second document.
    const mapping = await mappingFor(org, 'CogsJournalBatch', batch.id)
    expect(mapping?.externalId).toBe(forward.Id)
  })

  // ── §8 dependency-aware voids ─────────────────────────────────────────────

  it('waits for the invoice mapping rather than failing forever', async () => {
    const sale = await sell(4)
    qbo.failAlways('createCustomer', { kind: 'transient' })
    await runSync(org, qbo)

    const payment = await recordPayment(office.ctx, {
      customerId, method: 'CASH', amount: '20.00',
      strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
    })
    await reversePayment(office.ctx, payment.paymentId, 'Miscounted')
    await runSync(org, qbo)

    // The payment never reached QuickBooks, so there is nothing to void — and
    // that is recorded as done, not as a failure that retries forever.
    const voidJob = await jobOf('Payment', 'VOID', payment.paymentId)
    expect(voidJob?.status).toBe('SYNCED')
    expect(qbo.countOf('Payment')).toBe(0)
    void sale
  })

  // ── §9 void idempotency: the lost response ────────────────────────────────

  describe('a void whose response is lost', () => {
    async function losesResponse(
      method: string,
      run: () => Promise<void>,
      expectCount: () => number,
    ) {
      qbo.failNext(method, { kind: 'lose-response' })
      await run()
      await runSync(org, qbo)

      // The operation happened over there despite the failure.
      const afterFirst = expectCount()

      await db(org.ownerCtx).syncJob.updateMany({
        where: { operation: 'VOID', status: { not: 'SYNCED' } },
        data: { status: 'PENDING', nextAttemptAt: new Date() },
      })
      await runSync(org, qbo)

      expect(expectCount()).toBe(afterFirst)
    }

    it('voids an Invoice exactly once', async () => {
      const sale = await sell(4)
      await runSync(org, qbo)
      await losesResponse(
        'voidInvoice',
        () => voidSale(office.ctx, sale.saleId, 'Duplicate'),
        () => qbo.countOf('Invoice'),
      )
      expect(invoices()[0].void).toBe(true)
      expect(invoices()).toHaveLength(1)
      expect((await jobOf('Sale', 'VOID', sale.saleId))?.status).toBe('SYNCED')
    })

    it('voids a SalesReceipt exactly once', async () => {
      const sale = await sell(3, '64.35')
      await runSync(org, qbo)
      await losesResponse(
        'voidSalesReceipt',
        () => voidSale(office.ctx, sale.saleId, 'Rung up twice'),
        () => qbo.countOf('SalesReceipt'),
      )
      expect(qbo.allOf<QboSalesReceipt>('SalesReceipt')[0].void).toBe(true)
      expect(qbo.countOf('SalesReceipt')).toBe(1)
    })

    it('reverses a Payment exactly once', async () => {
      await sell(25)
      await runSync(org, qbo)
      const payment = await recordPayment(office.ctx, {
        customerId, method: 'CASH', amount: '200.00',
        strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
      })
      await runSync(org, qbo)

      await losesResponse(
        'voidPayment',
        () => reversePayment(office.ctx, payment.paymentId, 'Bounced'),
        () => qbo.countOf('Payment'),
      )
      expect(payments()[0].void).toBe(true)
      expect(qbo.countOf('Payment')).toBe(1)
    })

    it('zeroes a CreditMemo exactly once', async () => {
      const sale = await sell(4)
      await runSync(org, qbo)
      const item = await firstItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId, reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 2, disposition: 'DAMAGED' }],
        financialAction: 'ACCOUNT_CREDIT', idempotencyKey: randomUUID(),
      })
      await runSync(org, qbo)
      await db(org.ownerCtx).return.update({
        where: { id: result.returnId }, data: { creditMemoId: null },
      })

      await losesResponse(
        'updateCreditMemo',
        () => voidCreditMemo(office.ctx, result.creditMemoId!, 'Approved in error'),
        () => qbo.countOf('CreditMemo'),
      )
      expect(qbo.allOf<QboCreditMemo>('CreditMemo')[0].TotalAmt).toBe(0)
      expect(qbo.countOf('CreditMemo')).toBe(1)
    })

    it('zeroes a RefundReceipt exactly once', async () => {
      const sale = await sell(4, '85.80')
      await runSync(org, qbo)
      const item = await firstItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId, reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 2, disposition: 'DAMAGED' }],
        financialAction: 'REFUND', refund: { method: 'CASH' }, idempotencyKey: randomUUID(),
      })
      await runSync(org, qbo)
      const refund = await db(org.ownerCtx).refund.findFirstOrThrow({
        where: { creditMemoId: result.creditMemoId! },
      })

      await losesResponse(
        'updateRefundReceipt',
        () => voidRefund(office.ctx, refund.id, 'Never handed over'),
        () => qbo.countOf('RefundReceipt'),
      )
      expect(qbo.allOf<QboRefundReceipt>('RefundReceipt')[0].TotalAmt).toBe(0)
      expect(qbo.countOf('RefundReceipt')).toBe(1)
    })

    it('unapplies a credit exactly once', async () => {
      const sale = await sell(25)
      await runSync(org, qbo)
      const item = await firstItem(sale.saleId)
      const result = await createReturn(office.ctx, {
        saleId: sale.saleId, reason: 'DAMAGED',
        lines: [{ saleItemId: item.id, quantity: 5, disposition: 'DAMAGED' }],
        financialAction: 'APPLY_TO_BALANCE', idempotencyKey: randomUUID(),
      })
      await runSync(org, qbo)
      const before = qbo.countOf('Payment')

      await losesResponse(
        'voidPayment',
        () => unapplyCreditMemo(office.ctx, result.creditMemoId!).then(() => undefined),
        () => qbo.countOf('Payment'),
      )
      expect(qbo.countOf('Payment')).toBe(before)
      expect(payments().filter((entry) => entry.void).length).toBe(1)
    })

    it('reverses a COGS journal exactly once', async () => {
      await sell(10)
      await runSync(org, qbo)
      const today = localDateString(new Date(), org.ownerCtx.organization.timezone)
      const batch = await prepareCogsBatch(office.ctx, { from: today, to: today })
      await postCogsBatch(office.ctx, batch.id)
      await runSync(org, qbo)

      await losesResponse(
        'createJournalEntry',
        () => voidCogsBatch(office.ctx, batch.id, 'Period reopened'),
        () => qbo.countOf('JournalEntry'),
      )
      // One forward entry and exactly one reversal — never two reversals.
      expect(qbo.countOf('JournalEntry')).toBe(2)
    })
  })

  // ── §10 external conflict ─────────────────────────────────────────────────

  it('treats a void somebody already made in QuickBooks as reconciled', async () => {
    const sale = await sell(4)
    await runSync(org, qbo)
    const [invoice] = invoices()

    // A bookkeeper voids it over there first.
    await qbo.voidInvoice(invoice.Id!, invoice.SyncToken!, randomUUID())
    const callsBefore = qbo.calls.filter((call) => call.method === 'voidInvoice').length

    await voidSale(office.ctx, sale.saleId, 'Same conclusion, reached twice')
    await runSync(org, qbo)

    // The desired state is already true, so the job reconciles rather than
    // fighting over it — and nothing was sent.
    const job = await jobOf('Sale', 'VOID', sale.saleId)
    expect(job?.status).toBe('SYNCED')
    expect(qbo.calls.filter((call) => call.method === 'voidInvoice')).toHaveLength(callsBefore)
    expect(qbo.countOf('Invoice')).toBe(1)
  })

  it('raises an external conflict when their copy has moved on', async () => {
    const sale = await sell(4)
    await runSync(org, qbo)

    qbo.failAlways('voidInvoice', { kind: 'stale-token' })
    await voidSale(office.ctx, sale.saleId, 'Duplicate')
    await runSync(org, qbo)

    const job = await jobOf('Sale', 'VOID', sale.saleId)
    expect(job?.status).toBe('NEEDS_ATTENTION')
    expect(job?.errorCategory).toBe('EXTERNAL_CONFLICT')
    // Never recreated, never overwritten.
    expect(qbo.countOf('Invoice')).toBe(1)
  })

  // ── the credit that came back is usable again ─────────────────────────────

  it('lets a credit be reapplied after being unapplied, in both systems', async () => {
    const sale = await sell(25)
    await runSync(org, qbo)
    const total = toAmountString((await saleRow(sale.saleId)).total)
    const item = await firstItem(sale.saleId)

    const result = await createReturn(office.ctx, {
      saleId: sale.saleId, reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 5, disposition: 'DAMAGED' }],
      financialAction: 'APPLY_TO_BALANCE', idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)
    await unapplyCreditMemo(office.ctx, result.creditMemoId!)
    await runSync(org, qbo)

    await applyCreditMemo(office.ctx, { creditMemoId: result.creditMemoId! })
    await runSync(org, qbo)

    const live = payments().filter((entry) => entry.TotalAmt === 0 && !entry.void)
    expect(live).toHaveLength(1)
    expect(toAmountString(live[0].Line![0].Amount)).toBe(result.creditTotal)
    expect(toAmountString((await saleRow(sale.saleId)).balanceDue)).toBe(
      toAmountString(m(total).minus(result.creditTotal)),
    )
    expect((await getCreditPosition(office.ctx, customerId)).memoCredit).toBe('0.00')

    void issueRefund
    void createAdjustmentCredit
  })
})
