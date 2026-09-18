import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout } from '@/server/services/sale.service'
import { createReturn } from '@/server/services/return.service'
import {
  describeConnection,
  disconnect,
  listSyncHistory,
  listSyncIssues,
  mapManually,
  resyncDocument,
  retryJob,
  saveSettings,
} from '@/server/services/integration.service'
import { classifyFault } from '@/server/integrations/quickbooks/client'
import { backoffSeconds, MAX_ATTEMPTS } from '@/server/integrations/quickbooks/sync/queue'
import { readSettings } from '@/server/integrations/quickbooks/settings'
import { hint, open, safeEqual, seal } from '@/server/crypto/secretBox'
import { toAmountString } from '@/server/domain/money'
import type { FakeQuickBooks } from '@/server/integrations/quickbooks/fake'
import type { QboCreditMemo, QboInvoice } from '@/server/integrations/quickbooks/types'
import { addMember, createCustomer, createProduct, createTestOrg, type TestOrg } from '../helpers'
import {
  connectQuickBooks,
  DEFAULT_ACCOUNTS,
  disconnectFake,
  jobFor,
  jobsFor,
  mappingFor,
  runSync,
} from '../helpers/quickbooks'

/**
 * The adapter's behaviour under everything that is not the happy path
 * (docs/08 §8, spec §27, §31, §34, §35).
 *
 * A sandbox will not produce a revoked grant, a stale SyncToken or a rate limit
 * on demand, and a suite that waits for Intuit to have a bad day is a suite
 * nobody runs. So the fake produces them, and the real worker handles them.
 */
describe('QuickBooks adapter behaviour', () => {
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

  // ── error classification ──────────────────────────────────────────────────

  describe('classifying what Intuit says', () => {
    const fault = (code: string, message: string, type = 'ValidationFault') =>
      JSON.stringify({ Fault: { Error: [{ code, Message: message, Detail: message }], type } })

    it('treats 429 and 5xx as transient, and honours Retry-After', () => {
      const limited = classifyFault(429, fault('', 'Throttled'), '90')
      expect(limited.category).toBe('TRANSIENT')
      expect(limited.retryable).toBe(true)
      expect(limited.options.retryAfterSeconds).toBe(90)

      expect(classifyFault(503, '<html>gateway</html>').category).toBe('TRANSIENT')
      expect(classifyFault(500, fault('', 'Internal')).retryable).toBe(true)
    })

    it('treats an authorization failure as a human problem, not a retry', () => {
      const revoked = classifyFault(401, fault('3200', 'token expired', 'AUTHENTICATION'))
      expect(revoked.category).toBe('AUTHORIZATION')
      expect(revoked.retryable).toBe(false)
    })

    it('recognises a stale SyncToken as somebody else having edited their copy', () => {
      const stale = classifyFault(400, fault('5010', 'Object Not Found: Stale Object Error'))
      expect(stale.category).toBe('EXTERNAL_CONFLICT')
      expect(stale.retryable).toBe(false)
    })

    it('recognises a dead reference as a mapping problem', () => {
      const missing = classifyFault(400, fault('610', 'Object Not Found: AccountRef'))
      expect(missing.category).toBe('MAPPING')
    })

    it('never retries a validation rejection', () => {
      const rejected = classifyFault(400, fault('6000', 'Business Validation Error: duplicate'))
      expect(rejected.category).toBe('VALIDATION')
      expect(rejected.retryable).toBe(false)
    })

    it('keeps Intuit’s own code and text, verbatim', () => {
      const error = classifyFault(400, fault('6140', 'Duplicate Document Number Error'))
      expect(error.options.code).toBe('6140')
      expect(error.message).toContain('Duplicate Document Number')
    })
  })

  describe('backing off', () => {
    it('doubles with jitter and stops at an hour', () => {
      for (let attempt = 1; attempt <= 12; attempt++) {
        const seconds = backoffSeconds(attempt)
        expect(seconds).toBeGreaterThan(0)
        expect(seconds).toBeLessThanOrEqual(3600)
      }
      // Jitter is real: two calls at the same attempt should not always agree,
      // or a whole route's worth of jobs would come back in lockstep.
      const samples = new Set(Array.from({ length: 30 }, () => backoffSeconds(4)))
      expect(samples.size).toBeGreaterThan(1)
    })

    it('prefers Retry-After when QuickBooks supplied one', () => {
      expect(backoffSeconds(1, 45)).toBe(45)
      expect(backoffSeconds(1, 99_999)).toBe(3600)
    })
  })

  // ── retry, then stop ──────────────────────────────────────────────────────

  it('gives up on a transient failure that never clears, and says so', async () => {
    await sell(2)
    qbo.failAlways('createCustomer', { kind: 'transient' })

    for (let attempt = 0; attempt < MAX_ATTEMPTS + 1; attempt++) {
      await db(org.ownerCtx).syncJob.updateMany({
        where: { status: { in: ['RETRYING', 'PENDING', 'BLOCKED_DEPENDENCY'] } },
        data: { status: 'PENDING', nextAttemptAt: new Date(), blockedOnJobId: null },
      })
      await runSync(org, qbo, 2)
    }

    const job = await jobFor(org, 'Customer', customerId)
    expect(job?.status).toBe('NEEDS_ATTENTION')
    expect(job?.attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS)
    expect(job?.lastError).toMatch(/gave up after/)
  })

  it('does not call QuickBooks at all for a blocked document', async () => {
    await sell(2)
    qbo.failAlways('createCustomer', { kind: 'transient' })
    await runSync(org, qbo)

    // The invoice never went out: it is waiting on its customer, not failing.
    expect(qbo.calls.filter((call) => call.method === 'createInvoice')).toHaveLength(0)

    const saleJob = (await jobsFor(org)).find((job) => job.entityType === 'Sale')
    expect(saleJob?.status).toBe('BLOCKED_DEPENDENCY')
    expect(saleJob?.errorCategory).toBe('DEPENDENCY')
    expect(saleJob?.blockedOnJobId).toBeTruthy()
  })

  it('releases a blocked document the moment its dependency lands', async () => {
    await sell(2)
    qbo.failNext('createCustomer', { kind: 'transient' })
    await runSync(org, qbo, 1)

    await db(org.ownerCtx).syncJob.updateMany({
      where: { status: 'RETRYING' },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    })
    await runSync(org, qbo)

    expect(qbo.countOf('Invoice')).toBe(1)
    for (const job of await jobsFor(org)) expect(job.status).toBe('SYNCED')
  })

  // ── reconciliation refuses to accept drift ────────────────────────────────

  it('refuses a sync where QuickBooks recomputed the tax', async () => {
    const sale = await sell(3)
    // The company is on Automated Sales Tax and ignores our figure.
    qbo.failNext('createInvoice', { kind: 'recompute-tax', totalTax: 9.99 })
    await runSync(org, qbo)

    const job = await jobFor(org, 'Sale', sale.saleId)
    expect(job?.status).toBe('NEEDS_ATTENTION')
    expect(job?.errorCategory).toBe('TAX_MISMATCH')
    expect(job?.lastError).toContain('QuickBooks recorded 9.99')

    // The mapping still holds the external id — the document exists over there,
    // and re-sending it would be the duplicate we spent Phase 8 preventing.
    const mapping = await mappingFor(org, 'Sale', sale.saleId)
    expect(mapping?.status).toBe('NEEDS_ATTENTION')
    expect(qbo.countOf('Invoice')).toBe(1)
  })

  it('refuses a sync where QuickBooks landed on a different total', async () => {
    const sale = await sell(3)
    qbo.failNext('createInvoice', { kind: 'shift-total', by: 0.01 })
    await runSync(org, qbo)

    const job = await jobFor(org, 'Sale', sale.saleId)
    expect(job?.status).toBe('NEEDS_ATTENTION')
    expect(job?.errorCategory).toBe('AMOUNT_MISMATCH')
    // One cent. Deliberately not tolerated (§8).
    expect(job?.lastError).toMatch(/64\.35.*64\.36|64\.36.*64\.35/)
  })

  it('surfaces an edit made in QuickBooks instead of overwriting it', async () => {
    const sale = await sell(2)
    await runSync(org, qbo)

    await resyncDocument(office.ctx, 'Sale', sale.saleId)
    qbo.failNext('updateInvoice', { kind: 'stale-token' })
    await runSync(org, qbo)

    // The re-sync is its own job, with its own request id.
    const job = (await jobsFor(org)).find(
      (entry) => entry.entityType === 'Sale' && entry.operation === 'UPDATE',
    )
    expect(job?.status).toBe('NEEDS_ATTENTION')
    expect(job?.errorCategory).toBe('EXTERNAL_CONFLICT')

    const [issue] = (await listSyncIssues(office.ctx)).filter((i) => i.jobId === job?.id)
    expect(issue.action).toBe('REVIEW_DOCUMENT')
    expect(issue.suggestion).toMatch(/will not overwrite/i)
  })

  // ── mapping problems are actionable ───────────────────────────────────────

  it('tells a person which account to choose rather than failing obscurely', async () => {
    const settings = readSettings(null)
    settings.accounts = { ...DEFAULT_ACCOUNTS, salesIncome: undefined }
    await saveSettings(office.ctx, settings)

    await sell(2)
    await runSync(org, qbo)

    // The sale is refused before anything is sent, and the message names the
    // setting to change rather than echoing an Intuit error code.
    const issues = await listSyncIssues(office.ctx)
    const issue = issues.find((entry) => entry.entityType === 'Sale')
    expect(issue).toBeDefined()
    expect(issue!.category).toBe('MAPPING')
    expect(issue!.action).toBe('CHANGE_ACCOUNTS')
    expect(issue!.message).toMatch(/sales income account/i)
    expect(issue!.documentNumber).toMatch(/^S-/)
    expect(issue!.href).toBe(`/receipts/${issue!.localId}`)
  })

  it('retries everything that was waiting on a mapping when the mapping is fixed', async () => {
    const settings = readSettings(null)
    settings.accounts = { ...DEFAULT_ACCOUNTS, salesIncome: undefined }
    await saveSettings(office.ctx, settings)

    await sell(2)
    await runSync(org, qbo)
    expect(qbo.countOf('Item')).toBe(0)

    settings.accounts = DEFAULT_ACCOUNTS
    await saveSettings(office.ctx, settings)
    await runSync(org, qbo)

    expect(qbo.countOf('Item')).toBe(1)
    expect(qbo.countOf('Invoice')).toBe(1)
  })

  it('accepts a manual mapping to a record that already exists in QuickBooks', async () => {
    // A store already on the books, under a name nobody would match on.
    const existing = await qbo.createCustomer(
      { DisplayName: 'VALLEY BP #1010 (legacy)' },
      randomUUID(),
    )

    await sell(2)
    await mapManually(office.ctx, 'Customer', customerId, existing.Id!)
    await runSync(org, qbo)

    // No second customer was created; the invoice went to the one that existed.
    expect(qbo.countOf('Customer')).toBe(1)
    expect(qbo.allOf<QboInvoice>('Invoice')[0].CustomerRef.value).toBe(existing.Id)
  })

  // ── issues and history ────────────────────────────────────────────────────

  it('describes an issue as a document, not as a row id', async () => {
    const sale = await sell(3)
    qbo.failAlways('createInvoice', { kind: 'validation', message: 'Duplicate Document Number', code: '6140' })
    await runSync(org, qbo)

    const issues = await listSyncIssues(office.ctx)
    const issue = issues.find((entry) => entry.entityType === 'Sale')!
    const row = await db(org.ownerCtx).sale.findUniqueOrThrow({ where: { id: sale.saleId } })

    expect(issue.documentNumber).toBe(row.saleNumber)
    expect(issue.customerName).toBe("Joe's Marathon")
    expect(issue.message).toContain('Duplicate Document Number')
    expect(issue.href).toBe(`/receipts/${sale.saleId}`)
    expect(issue.retryable).toBe(false)
  })

  it('shows history with what synced and what it became', async () => {
    await sell(2)
    await runSync(org, qbo)

    const history = await listSyncHistory(office.ctx)
    expect(history.length).toBeGreaterThanOrEqual(3)

    const sale = history.find((entry) => entry.entityType === 'Sale')!
    expect(sale.status).toBe('SYNCED')
    expect(sale.documentNumber).toMatch(/^S-/)
    expect(sale.externalId).toBeTruthy()
  })

  it('puts a job back in the queue without minting a new request id', async () => {
    const sale = await sell(2)
    qbo.failAlways('createInvoice', { kind: 'validation' })
    await runSync(org, qbo)

    const before = await jobFor(org, 'Sale', sale.saleId)
    expect(before?.status).toBe('NEEDS_ATTENTION')

    qbo.clearFaults()
    await retryJob(office.ctx, before!.id)
    await runSync(org, qbo)

    const after = await jobFor(org, 'Sale', sale.saleId)
    expect(after?.status).toBe('SYNCED')
    expect(after?.requestId).toBe(before?.requestId)
    // Attempts are NOT reset: how hard this has been tried is the useful fact.
    expect(after!.attempts).toBeGreaterThan(before!.attempts)
  })

  // ── re-sync updates in place ──────────────────────────────────────────────

  it('re-syncs a mapped document as an update, never as a second document', async () => {
    const sale = await sell(3)
    await runSync(org, qbo)
    const [first] = qbo.allOf<QboInvoice>('Invoice')

    await resyncDocument(office.ctx, 'Sale', sale.saleId)
    await runSync(org, qbo)

    expect(qbo.countOf('Invoice')).toBe(1)
    const [after] = qbo.allOf<QboInvoice>('Invoice')
    expect(after.Id).toBe(first.Id)
    // An update bumps their SyncToken, which is how we know it was one.
    expect(Number(after.SyncToken)).toBeGreaterThan(Number(first.SyncToken))
    expect(qbo.calls.some((call) => call.method === 'updateInvoice')).toBe(true)
  })

  it('cannot change SnackLoad figures by re-syncing', async () => {
    const sale = await sell(3)
    await runSync(org, qbo)
    const before = await db(org.ownerCtx).sale.findUniqueOrThrow({ where: { id: sale.saleId } })

    await resyncDocument(office.ctx, 'Sale', sale.saleId)
    await runSync(org, qbo)

    const after = await db(org.ownerCtx).sale.findUniqueOrThrow({ where: { id: sale.saleId } })
    expect(toAmountString(after.total)).toBe(toAmountString(before.total))
    expect(toAmountString(after.taxTotal)).toBe(toAmountString(before.taxTotal))
    expect(after.documentType).toBe(before.documentType)
  })

  // ── legacy tax rows ───────────────────────────────────────────────────────

  it('sends a pre-snapshot document as posted, and says the detail is missing', async () => {
    const sale = await sell(3)
    // A document from before the tax snapshot existed (docs/08 §9).
    await db(org.ownerCtx).sale.update({
      where: { id: sale.saleId },
      data: { taxJson: Prisma.DbNull },
    })
    await runSync(org, qbo)

    const [invoice] = qbo.allOf<QboInvoice>('Invoice')
    const row = await db(org.ownerCtx).sale.findUniqueOrThrow({ where: { id: sale.saleId } })

    // The amounts are real and are sent as posted. Nothing is invented.
    expect(toAmountString(invoice.TotalAmt!)).toBe(toAmountString(row.total))
    expect(toAmountString(invoice.TxnTaxDetail!.TotalTax)).toBe(toAmountString(row.taxTotal))
    expect(invoice.PrivateNote).toContain('Tax detail not recorded')

    const job = await jobFor(org, 'Sale', sale.saleId)
    expect(job?.status).toBe('SYNCED')

    const log = await db(org.ownerCtx).syncLog.findFirstOrThrow({
      where: { syncJobId: job!.id, level: 'info' },
      orderBy: { createdAt: 'desc' },
    })
    expect(log.message).toMatch(/tax detail was not recorded/i)
  })

  // ── the credit carries the return's number ────────────────────────────────

  it('names the SnackLoad return on the credit memo without inventing a document for it', async () => {
    const sale = await sell(4)
    await runSync(org, qbo)

    const item = await db(org.ownerCtx).saleItem.findFirstOrThrow({ where: { saleId: sale.saleId } })
    const result = await createReturn(office.ctx, {
      saleId: sale.saleId,
      reason: 'DAMAGED',
      lines: [{ saleItemId: item.id, quantity: 1, disposition: 'DAMAGED' }],
      financialAction: 'ACCOUNT_CREDIT',
      idempotencyKey: randomUUID(),
    })
    await runSync(org, qbo)

    const [credit] = qbo.allOf<QboCreditMemo>('CreditMemo')
    const returnRow = await db(org.ownerCtx).return.findUniqueOrThrow({ where: { id: result.returnId } })
    expect(credit.PrivateNote).toContain(returnRow.returnNumber)

    // And no job was ever created for the goods document itself.
    const jobs = await jobsFor(org)
    expect(jobs.some((job) => job.entityType === 'Return')).toBe(false)
  })

  // ── connection lifecycle ──────────────────────────────────────────────────

  it('reports the connection without ever exposing a token', async () => {
    const view = await describeConnection(office.ctx)
    expect(view.status).toBe('CONNECTED')
    expect(view.environment).toBe('SANDBOX')
    expect(view.realmId).toBe('4620816365320400000')
    expect(view.companyName).toBe('Sandbox Company_US_1')

    const serialised = JSON.stringify(view)
    expect(serialised).not.toMatch(/accessToken|refreshToken|Encrypted/i)
  })

  it('keeps mappings and logs when disconnected', async () => {
    await sell(2)
    await runSync(org, qbo)

    const mappingsBefore = await db(org.ownerCtx).externalMapping.count()
    const logsBefore = await db(org.ownerCtx).syncLog.count()
    expect(mappingsBefore).toBeGreaterThan(0)

    await disconnect(office.ctx)

    const connection = await db(org.ownerCtx).integrationConnection.findFirstOrThrow({
      where: { provider: 'QUICKBOOKS_ONLINE' },
    })
    expect(connection.status).toBe('DISCONNECTED')
    expect(connection.accessTokenEncrypted).toBeNull()
    expect(connection.refreshTokenEncrypted).toBeNull()
    // History is not a credential (§10).
    expect(await db(org.ownerCtx).externalMapping.count()).toBe(mappingsBefore)
    expect(await db(org.ownerCtx).syncLog.count()).toBe(logsBefore)

    const view = await describeConnection(office.ctx)
    expect(view.status).toBe('NOT_CONNECTED')
  })

  it('stops queueing once disconnected, and the worker does nothing', async () => {
    await disconnect(office.ctx)
    const sale = await sell(2)

    expect(await jobFor(org, 'Sale', sale.saleId)).toBeUndefined()
    const result = await runSync(org, qbo)
    expect(result.synced).toBe(0)
  })

  // ── secrets ───────────────────────────────────────────────────────────────

  describe('sealing secrets at rest', () => {
    it('round-trips, and does not store the plaintext', () => {
      const token = `refresh-${randomUUID()}`
      const sealed = seal(token)
      expect(sealed).toMatch(/^v1:/)
      expect(sealed).not.toContain(token)
      expect(open(sealed)).toBe(token)
    })

    it('produces a different ciphertext every time', () => {
      const token = 'the-same-token'
      expect(seal(token)).not.toBe(seal(token))
    })

    it('refuses a tampered ciphertext rather than returning nonsense', () => {
      const sealed = seal('access-token')
      const parts = sealed.split(':')
      const tampered = [parts[0], parts[1], parts[2], Buffer.from('evil').toString('base64url')].join(':')
      expect(() => open(tampered)).toThrow()
    })

    it('masks rather than reveals', () => {
      expect(hint('abcdefghijkl')).toBe('••••ijkl')
      expect(hint('short')).toBe('••••')
      expect(hint(null)).toBe('••••')
    })

    it('compares in constant time without leaking length mismatches', () => {
      expect(safeEqual('abc', 'abc')).toBe(true)
      expect(safeEqual('abc', 'abd')).toBe(false)
      expect(safeEqual('abc', 'abcd')).toBe(false)
    })
  })

  // ── environments are explicit ─────────────────────────────────────────────

  it('records which QuickBooks it is talking to, and never infers it', async () => {
    const view = await describeConnection(office.ctx)
    expect(view.environment).toBe('SANDBOX')

    // Connecting to production is a separate, deliberate act.
    await connectQuickBooks(org, { environment: 'PRODUCTION', realmId: '9999999999' })
    const production = await describeConnection(office.ctx)
    expect(production.environment).toBe('PRODUCTION')
    expect(production.realmId).toBe('9999999999')
  })
})
