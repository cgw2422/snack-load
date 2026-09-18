import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout } from '@/server/services/sale.service'
import { recordPayment } from '@/server/services/payment.service'
import { createReturn } from '@/server/services/return.service'
import { applyCreditMemo, getCreditPosition } from '@/server/services/credit.service'
import { postCogsBatch, prepareCogsBatch } from '@/server/services/cogs.service'
import { runReport } from '@/server/reports'
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
import { connectQuickBooks, disconnectFake, jobFor, jobsFor, mappingFor, runSync } from '../helpers/quickbooks'

/**
 * The accounting scenarios (spec §39).
 *
 * Each one is a thing a distributor actually does, followed all the way from a
 * runner tapping a button to what the bookkeeper sees. They assert the money on
 * both sides, because a sync that moves data without preserving totals is a
 * reconciliation problem nobody discovers until year end.
 */
describe('QuickBooks accounting scenarios', () => {
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
    await db(org.ownerCtx).customer.update({
      where: { id: customerId },
      data: { taxRateId: taxRate.id, email: 'orders@valleybp.test', phone: '(419) 555-0143' },
    })

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

  const saleRow = (saleId: string) =>
    db(org.ownerCtx).sale.findUniqueOrThrow({ where: { id: saleId } })

  const firstSaleItem = (saleId: string) =>
    db(org.ownerCtx).saleItem.findFirstOrThrow({ where: { saleId } })

  const invoices = () => qbo.allOf<QboInvoice>('Invoice')
  const receipts = () => qbo.allOf<QboSalesReceipt>('SalesReceipt')
  const payments = () => qbo.allOf<QboPayment>('Payment')
  const credits = () => qbo.allOf<QboCreditMemo>('CreditMemo')

  // ── A. COD cash sale → SalesReceipt ───────────────────────────────────────

  it('A — a sale paid at the counter becomes a SalesReceipt that reconciles', async () => {
    const sale = await sell(3, '64.35')
    const row = await saleRow(sale.saleId)
    expect(row.documentType).toBe('SALES_RECEIPT')

    const result = await runSync(org, qbo)
    expect(result.failed).toBe(0)

    // The customer and the item were created on the way, in that order.
    expect(qbo.countOf('Customer')).toBe(1)
    expect(qbo.countOf('Item')).toBe(1)
    expect(qbo.countOf('SalesReceipt')).toBe(1)
    expect(qbo.countOf('Invoice')).toBe(0)

    const [receipt] = receipts()
    expect(toAmountString(m(receipt.TotalAmt!))).toBe(toAmountString(row.total))
    expect(toAmountString(m(receipt.TxnTaxDetail!.TotalTax))).toBe(toAmountString(row.taxTotal))
    expect(receipt.PrivateNote).toContain(row.saleNumber)

    // The item is non-inventory, because SnackLoad owns the stock.
    expect(qbo.allOf<{ Type: string }>('Item')[0].Type).toBe('NonInventory')

    // And the counter payment produced no separate QuickBooks Payment: the
    // receipt already records the money.
    expect(qbo.countOf('Payment')).toBe(0)
    const paymentJob = await jobFor(org, 'Payment')
    expect(paymentJob?.status).toBe('SYNCED')
  })

  // ── B. on-account sale → Invoice, then Payment ────────────────────────────

  it('B — an invoice, then a payment linked to it', async () => {
    const sale = await sell(4)
    const row = await saleRow(sale.saleId)
    expect(row.documentType).toBe('INVOICE')

    await runSync(org, qbo)
    expect(qbo.countOf('Invoice')).toBe(1)

    const [invoice] = invoices()
    expect(toAmountString(m(invoice.TotalAmt!))).toBe(toAmountString(row.total))
    expect(invoice.DueDate).toBeDefined()

    await recordPayment(office.ctx, {
      customerId, method: 'CHECK', amount: '85.80', checkNumber: '10441',
      strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)

    expect(qbo.countOf('Payment')).toBe(1)
    const [payment] = payments()
    expect(payment.TotalAmt).toBe(85.8)
    expect(payment.PaymentRefNum).toBe('10441')
    expect(payment.Line?.[0].LinkedTxn[0]).toEqual({ TxnId: invoice.Id, TxnType: 'Invoice' })

    // Paying it off does NOT turn it into a sales receipt (§7).
    expect((await saleRow(sale.saleId)).documentType).toBe('INVOICE')
    expect(qbo.countOf('SalesReceipt')).toBe(0)
  })

  // ── C. partial payments ───────────────────────────────────────────────────

  it('C — two payments against one invoice, linked and not duplicated', async () => {
    const sale = await sell(25) // $500 of goods
    const row = await saleRow(sale.saleId)
    await runSync(org, qbo)
    const [invoice] = invoices()

    await recordPayment(office.ctx, {
      customerId, method: 'CASH', amount: '200.00',
      strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)

    const remaining = toAmountString(m(row.total).minus(200))
    await recordPayment(office.ctx, {
      customerId, method: 'CASH', amount: remaining,
      strategy: 'OLDEST_FIRST', idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)

    expect(qbo.countOf('Invoice')).toBe(1)
    expect(qbo.countOf('Payment')).toBe(2)

    for (const payment of payments()) {
      expect(payment.Line?.[0].LinkedTxn[0]).toEqual({ TxnId: invoice.Id, TxnType: 'Invoice' })
    }

    const applied = payments().reduce((total, p) => total.plus(m(p.TotalAmt)), m(0))
    expect(toAmountString(applied)).toBe(toAmountString(row.total))
    expect(toAmountString((await saleRow(sale.saleId)).balanceDue)).toBe('0.00')
  })

  // ── D. return against an open invoice ─────────────────────────────────────

  it('D — a credit memo applied to the invoice it came from', async () => {
    const sale = await sell(4)
    await runSync(org, qbo)
    const [invoice] = invoices()

    const item = await firstSaleItem(sale.saleId)
    const result = await createReturn(office.ctx, {
      saleId: sale.saleId,
      reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 2, disposition: 'DAMAGED' }],
      financialAction: 'APPLY_TO_BALANCE',
      idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)

    expect(qbo.countOf('CreditMemo')).toBe(1)
    const [credit] = credits()
    expect(toAmountString(m(credit.TotalAmt!))).toBe(result.creditTotal)
    // The goods document has no QuickBooks object; its number rides on the note.
    expect(credit.PrivateNote).toMatch(/RT-\d+/)

    // The application is a zero-total Payment linking both — not a guess that
    // QuickBooks will pick the right invoice (§7).
    const application = payments().find((p) => p.TotalAmt === 0)
    expect(application).toBeDefined()
    const linked = application!.Line![0].LinkedTxn.map((txn) => txn.TxnType).sort()
    expect(linked).toEqual(['CreditMemo', 'Invoice'])
    expect(application!.Line![0].LinkedTxn).toContainEqual({ TxnId: invoice.Id, TxnType: 'Invoice' })
    expect(application!.Line![0].Amount).toBe(Number(result.applied))

    // Both systems agree on what is still owed.
    const row = await saleRow(sale.saleId)
    expect(toAmountString(row.balanceDue)).toBe(
      toAmountString(m(row.total).minus(result.applied)),
    )
  })

  // ── E. refunding a paid sale ──────────────────────────────────────────────

  it('E — a refund against a paid counter sale becomes a RefundReceipt', async () => {
    const sale = await sell(3, '64.35')
    await runSync(org, qbo)
    expect(qbo.countOf('SalesReceipt')).toBe(1)

    const item = await firstSaleItem(sale.saleId)
    const result = await createReturn(office.ctx, {
      saleId: sale.saleId,
      reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
      financialAction: 'REFUND',
      refund: { method: 'CASH' },
      idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)

    expect(qbo.countOf('CreditMemo')).toBe(1)
    expect(qbo.countOf('RefundReceipt')).toBe(1)

    const [refundReceipt] = qbo.allOf<QboRefundReceipt>('RefundReceipt')
    expect(toAmountString(m(refundReceipt.TotalAmt!))).toBe(result.refunded)
    expect(refundReceipt.PrivateNote).toMatch(/RF-\d+/)

    // And the credit is consumed rather than left sitting as available credit.
    const link = payments().find((p) => p.TotalAmt === 0)
    expect(link).toBeDefined()
    expect(link!.Line![0].LinkedTxn.map((t) => t.TxnType).sort()).toEqual([
      'CreditMemo',
      'RefundReceipt',
    ])

    const position = await getCreditPosition(office.ctx, customerId)
    expect(position.memoCredit).toBe('0.00')
  })

  // ── F. unapplied credit, applied later ────────────────────────────────────

  it('F — a credit left on the account, then applied to a later invoice', async () => {
    const first = await sell(3)
    await runSync(org, qbo)

    const item = await firstSaleItem(first.saleId)
    const result = await createReturn(office.ctx, {
      saleId: first.saleId,
      reason: 'UNSOLD',
      lines: [{ saleItemId: item.id, quantity: 3, disposition: 'RESTOCK_TRUCK' }],
      financialAction: 'ACCOUNT_CREDIT',
      idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)

    // Nothing applied it: the credit memo alone is the whole representation.
    expect(qbo.countOf('CreditMemo')).toBe(1)
    expect(payments()).toHaveLength(0)
    expect((await getCreditPosition(office.ctx, customerId)).memoCredit).toBe(result.creditTotal)

    // A later invoice, and the credit goes against it.
    const second = await sell(5)
    await runSync(org, qbo)
    await applyCreditMemo(office.ctx, { creditMemoId: result.creditMemoId! })
    await runSync(org, qbo)

    const applications = payments().filter((p) => p.TotalAmt === 0)
    expect(applications).toHaveLength(1)

    // One credit memo, one application, no accidental refund.
    expect(invoices()).toHaveLength(2)
    expect(invoices().some((invoice) => invoice.PrivateNote?.includes(second.saleNumber))).toBe(true)
    expect(qbo.countOf('CreditMemo')).toBe(1)
    expect(qbo.countOf('RefundReceipt')).toBe(0)
    expect(applications[0].Line![0].LinkedTxn).toHaveLength(2)
  })

  // ── G. QuickBooks offline ─────────────────────────────────────────────────

  it('G — Intuit is down, the runner still sells, and it syncs once when it is back', async () => {
    qbo.failAlways('createCustomer', { kind: 'transient', message: 'Could not reach QuickBooks.' })
    qbo.failAlways('createInvoice', { kind: 'transient' })

    // The sale itself is completely unaffected.
    const sale = await sell(4)
    const row = await saleRow(sale.saleId)
    expect(row.status).toBe('COMPLETED')
    expect(toAmountString(row.total)).toBe('85.80')

    await runSync(org, qbo)
    expect(qbo.countOf('Invoice')).toBe(0)

    const blocked = await jobsFor(org)
    const saleJob = blocked.find((job) => job.entityType === 'Sale')
    expect(['BLOCKED_DEPENDENCY', 'RETRYING']).toContain(saleJob?.status)

    const customerJob = blocked.find((job) => job.entityType === 'Customer')
    expect(customerJob?.status).toBe('RETRYING')
    expect(customerJob?.errorCategory).toBe('TRANSIENT')

    // Intuit comes back.
    qbo.clearFaults()
    await db(org.ownerCtx).syncJob.updateMany({
      where: { status: { in: ['RETRYING', 'BLOCKED_DEPENDENCY'] } },
      data: { status: 'PENDING', nextAttemptAt: new Date(), blockedOnJobId: null },
    })
    await runSync(org, qbo)

    expect(qbo.countOf('Invoice')).toBe(1)
    expect(toAmountString(m(invoices()[0].TotalAmt!))).toBe('85.80')
    expect((await jobFor(org, 'Sale', sale.saleId))?.status).toBe('SYNCED')
  })

  // ── H. authorization revoked ──────────────────────────────────────────────

  it('H — the grant is revoked, selling carries on, reconnecting resumes', async () => {
    await sell(2)
    await runSync(org, qbo)
    expect(qbo.countOf('Invoice')).toBe(1)

    qbo.failAlways('createInvoice', { kind: 'auth-revoked' })
    const during = await sell(3)

    // Selling is untouched by an integration that cannot authenticate.
    expect((await saleRow(during.saleId)).status).toBe('COMPLETED')

    await runSync(org, qbo)

    const connection = await db(org.ownerCtx).integrationConnection.findFirstOrThrow({
      where: { provider: 'QUICKBOOKS_ONLINE' },
    })
    expect(connection.status).toBe('NEEDS_REAUTH')

    const job = await jobFor(org, 'Sale', during.saleId)
    expect(job?.status).toBe('NEEDS_ATTENTION')
    expect(job?.errorCategory).toBe('AUTHORIZATION')

    // Mappings survive. Reconnecting resumes rather than restarting (§10).
    const firstMapping = await mappingFor(org, 'Customer', customerId)
    expect(firstMapping?.externalId).toBeTruthy()

    qbo.clearFaults()
    await db(org.ownerCtx).integrationConnection.updateMany({
      where: { provider: 'QUICKBOOKS_ONLINE' },
      data: { status: 'CONNECTED', lastError: null },
    })
    await db(org.ownerCtx).syncJob.updateMany({
      where: { status: { in: ['NEEDS_ATTENTION', 'RETRYING', 'BLOCKED_DEPENDENCY'] } },
      data: { status: 'PENDING', nextAttemptAt: new Date(), blockedOnJobId: null },
    })
    await runSync(org, qbo)

    expect(qbo.countOf('Invoice')).toBe(2)
    expect(qbo.countOf('Customer')).toBe(1)
  })

  // ── COGS ties to the report ───────────────────────────────────────────────

  it('the COGS journal ties exactly to the gross-profit report for the period', async () => {
    const sale = await sell(10)
    const item = await firstSaleItem(sale.saleId)
    await createReturn(office.ctx, {
      saleId: sale.saleId,
      reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 3, disposition: 'DAMAGED' }],
      financialAction: 'ACCOUNT_CREDIT',
      idempotencyKey: randomUUID(),
    })

    const today = localDateString(new Date(), org.ownerCtx.organization.timezone)
    const batch = await prepareCogsBatch(office.ctx, { from: today, to: today })

    const report = await runReport(office.ctx, 'gross-profit', { from: today, to: today })
    const reportCogs = report.totals?.cogs as string

    // The same arithmetic over the same columns. Not close: equal.
    expect(batch.totalCogs).toBe(reportCogs)
    expect(batch.salesCogs).toBe('144.00')
    expect(batch.returnCogs).toBe('43.20')
    expect(batch.totalCogs).toBe('100.80')

    await postCogsBatch(office.ctx, batch.id)
    await runSync(org, qbo)

    const [journal] = qbo.allOf<QboJournalEntry>('JournalEntry')
    const debit = journal.Line.find((line) => line.JournalEntryLineDetail.PostingType === 'Debit')!
    const credit = journal.Line.find((line) => line.JournalEntryLineDetail.PostingType === 'Credit')!
    expect(debit.Amount).toBe(100.8)
    expect(credit.Amount).toBe(100.8)
    expect(debit.JournalEntryLineDetail.AccountRef.value).toBe('5')
    expect(credit.JournalEntryLineDetail.AccountRef.value).toBe('6')
    expect(journal.PrivateNote).toContain(batch.id)
  })
})
