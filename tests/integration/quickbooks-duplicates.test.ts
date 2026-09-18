import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout } from '@/server/services/sale.service'
import { recordPayment } from '@/server/services/payment.service'
import { createReturn } from '@/server/services/return.service'
import { postCogsBatch, prepareCogsBatch } from '@/server/services/cogs.service'
import { localDateString } from '@/lib/dates'
import type { FakeQuickBooks } from '@/server/integrations/quickbooks/fake'
import {
  addMember,
  createCustomer,
  createProduct,
  createTestOrg,
  type TestOrg,
} from '../helpers'
import { connectQuickBooks, disconnectFake, jobFor, mappingFor, runSync } from '../helpers/quickbooks'

/**
 * The mandatory duplicate-prevention suite (docs/08 §5, spec §36).
 *
 * The failure it exists for, in order:
 *
 *   1. SnackLoad sends a document.
 *   2. QuickBooks creates it.
 *   3. The response is lost — a socket hang-up, a dead cell tower, a container
 *      that went away.
 *   4. The worker, correctly, retries.
 *   5. Exactly one document must exist in QuickBooks.
 *
 * Two mechanisms make step 5 true, and both are asserted here rather than
 * assumed. The **request id** is minted once per job and reused on every
 * attempt, so Intuit replays the original response instead of creating a second
 * document. The **mapping row** is opened before the call, so even a system
 * that had never heard of request ids would know something was in flight.
 *
 * `lose-response` in the fake writes to its idempotency ledger *before* it
 * throws, which is exactly the interleaving that makes this hard.
 */
describe('QuickBooks duplicate prevention', () => {
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
        name: 'Ohio 7.25%',
        rate: '0.0725',
        code: 'OH-STATE',
        jurisdiction: 'Ohio',
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
      name: 'Takis Fuego', unitsPerCase: 12, casePrice: '20.00', costPerBaseUnit: '1.200000',
    })

    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 100, unitCost: '14.40' }],
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
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 60 }],
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

  const firstSaleItem = (saleId: string) =>
    db(org.ownerCtx).saleItem.findFirstOrThrow({ where: { saleId } })

  it('creates one Invoice when the response to the first attempt is lost', async () => {
    const sale = await sell(3)

    // The invoice's first attempt reaches QuickBooks and then vanishes on the
    // way back. The customer and the item ahead of it sync normally.
    qbo.failNext('createInvoice', { kind: 'lose-response' })
    await runSync(org, qbo)
    // The document is there despite the failure — that is the trap.
    expect(qbo.countOf('Invoice')).toBe(1)

    const afterFirst = await jobFor(org, 'Sale', sale.saleId)
    expect(afterFirst?.status).toBe('RETRYING')

    // Retry, as the worker would once the backoff elapses.
    await db(org.ownerCtx).syncJob.updateMany({
      where: { entityType: 'Sale' },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    })
    await runSync(org, qbo)

    expect(qbo.countOf('Invoice')).toBe(1)

    const job = await jobFor(org, 'Sale', sale.saleId)
    expect(job?.status).toBe('SYNCED')

    const mapping = await mappingFor(org, 'Sale', sale.saleId)
    expect(mapping?.externalId).toBe(qbo.allOf<{ Id: string }>('Invoice')[0].Id)
    expect(mapping?.status).toBe('SYNCED')

    // Both attempts carried the same request id. That is the mechanism.
    const invoiceCalls = qbo.calls.filter((call) => call.method === 'createInvoice')
    expect(invoiceCalls).toHaveLength(2)
    expect(invoiceCalls[0].requestId).toBe(invoiceCalls[1].requestId)
    expect(invoiceCalls[0].requestId).toBe(job?.requestId)
  })

  it('creates one SalesReceipt when the response is lost', async () => {
    const sale = await sell(2, '42.90')

    await db(org.ownerCtx).syncJob.updateMany({
      where: { entityType: 'Sale' },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    })
    qbo.failNext('createSalesReceipt', { kind: 'lose-response' })
    await runSync(org, qbo)
    expect(qbo.countOf('SalesReceipt')).toBe(1)

    await db(org.ownerCtx).syncJob.updateMany({
      where: { entityType: 'Sale' },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    })
    await runSync(org, qbo)

    expect(qbo.countOf('SalesReceipt')).toBe(1)
    expect((await jobFor(org, 'Sale', sale.saleId))?.status).toBe('SYNCED')
  })

  it('creates one Payment when the response is lost', async () => {
    const sale = await sell(3)
    await runSync(org, qbo)

    await recordPayment(office.ctx, {
      customerId,
      method: 'CHECK',
      amount: '20.00',
      checkNumber: '10441',
      strategy: 'OLDEST_FIRST',
      idempotencyKey: randomUUID(),
    })

    qbo.failNext('createPayment', { kind: 'lose-response' })
    await runSync(org, qbo)
    expect(qbo.countOf('Payment')).toBe(1)

    await db(org.ownerCtx).syncJob.updateMany({
      where: { entityType: 'Payment', status: { not: 'SYNCED' } },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    })
    await runSync(org, qbo)

    expect(qbo.countOf('Payment')).toBe(1)
    void sale
  })

  it('creates one CreditMemo when the response is lost', async () => {
    const sale = await sell(4)
    await runSync(org, qbo)

    const item = await firstSaleItem(sale.saleId)
    const result = await createReturn(office.ctx, {
      saleId: sale.saleId,
      reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 2, disposition: 'DAMAGED' }],
      financialAction: 'ACCOUNT_CREDIT',
      idempotencyKey: randomUUID(),
    })

    qbo.failNext('createCreditMemo', { kind: 'lose-response' })
    await runSync(org, qbo)
    expect(qbo.countOf('CreditMemo')).toBe(1)

    await db(org.ownerCtx).syncJob.updateMany({
      where: { entityType: 'CreditMemo', status: { not: 'SYNCED' } },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    })
    await runSync(org, qbo)

    expect(qbo.countOf('CreditMemo')).toBe(1)
    const mapping = await mappingFor(org, 'CreditMemo', result.creditMemoId!)
    expect(mapping?.status).toBe('SYNCED')
  })

  it('creates one COGS JournalEntry when the response is lost', async () => {
    await sell(5)
    await runSync(org, qbo)

    const today = localDateString(new Date(), org.ownerCtx.organization.timezone)
    const draft = await prepareCogsBatch(office.ctx, { from: today, to: today })
    expect(draft.totalCogs).toBe('72.00')
    await postCogsBatch(office.ctx, draft.id)

    qbo.failNext('createJournalEntry', { kind: 'lose-response' })
    await runSync(org, qbo)
    expect(qbo.countOf('JournalEntry')).toBe(1)

    await db(org.ownerCtx).syncJob.updateMany({
      where: { entityType: 'CogsJournalBatch', status: { not: 'SYNCED' } },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    })
    await runSync(org, qbo)

    expect(qbo.countOf('JournalEntry')).toBe(1)
    const mapping = await mappingFor(org, 'CogsJournalBatch', draft.id)
    expect(mapping?.status).toBe('SYNCED')
  })

  it('creates one Customer when the response is lost', async () => {
    await sell(1)
    qbo.failNext('createCustomer', { kind: 'lose-response' })

    await runSync(org, qbo)
    expect(qbo.countOf('Customer')).toBe(1)

    await db(org.ownerCtx).syncJob.updateMany({
      where: { status: { in: ['RETRYING', 'BLOCKED_DEPENDENCY'] } },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    })
    await runSync(org, qbo)

    expect(qbo.countOf('Customer')).toBe(1)
    expect(qbo.countOf('Invoice')).toBe(1)
  })

  it('does not re-send a document whose content has not changed', async () => {
    const sale = await sell(3)
    await runSync(org, qbo)
    expect(qbo.countOf('Invoice')).toBe(1)

    const before = qbo.calls.filter((call) => call.method.startsWith('create')).length

    // Re-queue the same work. Nothing about the sale has changed, so the hash
    // matches and there is nothing to send.
    await db(org.ownerCtx).syncJob.updateMany({
      where: { entityType: 'Sale', localId: sale.saleId },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    })
    await runSync(org, qbo)

    expect(qbo.countOf('Invoice')).toBe(1)
    expect(qbo.calls.filter((call) => call.method.startsWith('create'))).toHaveLength(before)
  })

  it('never mints a second request id for the same job', async () => {
    const sale = await sell(2)
    await runSync(org, qbo)

    const first = await jobFor(org, 'Sale', sale.saleId)

    // A SYNC NOW, a webhook and a re-post all land on the same row.
    for (let i = 0; i < 3; i++) {
      await db(org.ownerCtx).syncJob.updateMany({
        where: { id: first!.id },
        data: { status: 'PENDING', nextAttemptAt: new Date() },
      })
      await runSync(org, qbo)
    }

    const after = await jobFor(org, 'Sale', sale.saleId)
    expect(after?.requestId).toBe(first?.requestId)
    expect(qbo.countOf('Invoice')).toBe(1)
  })
})
