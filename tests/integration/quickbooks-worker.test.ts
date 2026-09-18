import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout } from '@/server/services/sale.service'
import { describeConnection } from '@/server/services/integration.service'
import { sweep } from '@/server/integrations/quickbooks/sync/scheduler'
import { drain } from '@/server/integrations/quickbooks/sync/worker'
import { claimNext, countExpiredLeases, LEASE_SECONDS } from '@/server/integrations/quickbooks/sync/queue'
import type { FakeQuickBooks } from '@/server/integrations/quickbooks/fake'
import type { QboInvoice } from '@/server/integrations/quickbooks/types'
import { addMember, createCustomer, createProduct, createTestOrg, type TestOrg } from '../helpers'
import { connectQuickBooks, disconnectFake, jobsFor } from '../helpers/quickbooks'

/**
 * The scheduled worker (docs/08 §20).
 *
 * Two questions, and a queue that gets either wrong is worse than no queue:
 * can two workers running at once process the same job, and does a job survive
 * the worker that claimed it dying?
 */
describe('the QuickBooks sync worker', () => {
  let org: TestOrg
  let runner: Awaited<ReturnType<typeof addMember>>
  let qbo: FakeQuickBooks
  let customerId: string
  let product: Awaited<ReturnType<typeof createProduct>>

  beforeEach(async () => {
    org = await createTestOrg()
    runner = await addMember(org, 'runner', { firstName: 'Mike', lastName: 'Donnelly' })
    const customer = await createCustomer(org.organizationId)
    customerId = customer.id

    product = await createProduct(org.organizationId, {
      name: 'Takis Fuego', unitsPerCase: 12, casePrice: '20.00', costPerBaseUnit: '1.200000',
      taxable: false,
    })
    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 400, unitCost: '14.40' }],
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
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 300 }],
    })

    qbo = await connectQuickBooks(org)
  })

  afterEach(async () => {
    disconnectFake()
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  const sell = (cases: number) =>
    checkout(runner.ctx, {
      customerId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: cases }],
    })

  // ── §15 two workers at once ───────────────────────────────────────────────

  it('runs each job once when two workers start simultaneously', async () => {
    for (let i = 0; i < 8; i++) await sell(1 + i)

    // Both start before either is awaited. Genuinely competing, not sequential.
    const [a, b] = await Promise.all([
      drain({ organizationId: org.organizationId, client: qbo, limit: 50, leaseOwner: 'worker-a' }),
      drain({ organizationId: org.organizationId, client: qbo, limit: 50, leaseOwner: 'worker-b' }),
    ])

    // Both workers ran, and between them the queue drained.
    expect(a.processed + b.processed).toBeGreaterThan(0)
    await drain({ organizationId: org.organizationId, client: qbo, limit: 50, leaseOwner: 'settle' })

    const jobs = await jobsFor(org)
    expect(jobs.filter((job) => job.entityType === 'Sale')).toHaveLength(8)
    for (const job of jobs) expect(job.status).toBe('SYNCED')

    /**
     * The real proof of "once, logically": one outbound create per document.
     *
     * Counting `attempts` would be wrong — a job blocked on its customer and
     * then on its item genuinely attempts three times, and that is the
     * dependency machinery working, not double processing.
     */
    const creates = (method: string) => qbo.calls.filter((call) => call.method === method).length
    expect(creates('createCustomer')).toBe(1)
    expect(creates('createItem')).toBe(1)
    expect(creates('createInvoice')).toBe(8)

    expect(qbo.countOf('Customer')).toBe(1)
    expect(qbo.countOf('Item')).toBe(1)
    expect(qbo.countOf('Invoice')).toBe(8)
  })

  it('never lets two workers claim the same job', async () => {
    await sell(2)
    await sell(3)

    const prisma = db(org.ownerCtx)
    const claims = await Promise.all([
      claimNext(prisma, org.organizationId, new Date(), 'worker-a'),
      claimNext(prisma, org.organizationId, new Date(), 'worker-b'),
      claimNext(prisma, org.organizationId, new Date(), 'worker-c'),
    ])

    const claimed = claims.filter((entry): entry is { id: string } => entry !== null)
    // Two jobs, three workers: at most two claims, all distinct.
    expect(claimed.length).toBeLessThanOrEqual(2)
    expect(new Set(claimed.map((entry) => entry.id)).size).toBe(claimed.length)
  })

  it('syncs a document exactly once across many concurrent sweeps', async () => {
    const sale = await sell(4)

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        drain({
          organizationId: org.organizationId,
          client: qbo,
          limit: 50,
          leaseOwner: `worker-${index}`,
        }),
      ),
    )
    // Dependencies release across passes, so drain once more to settle.
    await drain({ organizationId: org.organizationId, client: qbo, limit: 50, leaseOwner: 'final' })

    expect(qbo.countOf('Invoice')).toBe(1)
    expect(qbo.countOf('Customer')).toBe(1)
    expect(qbo.allOf<QboInvoice>('Invoice')[0].TotalAmt).toBe(80)

    const job = (await jobsFor(org)).find((entry) => entry.localId === sale.saleId)
    expect(job?.status).toBe('SYNCED')
  })

  // ── §16 stuck-job recovery ────────────────────────────────────────────────

  describe('a worker that never came back', () => {
    it('does not leave a job claimed forever', async () => {
      await sell(2)
      const prisma = db(org.ownerCtx)

      const claimed = await claimNext(prisma, org.organizationId, new Date(), 'worker-that-dies')
      expect(claimed).not.toBeNull()

      // It died here. No `finish`, no release.
      const stuck = await prisma.syncJob.findUniqueOrThrow({ where: { id: claimed!.id } })
      expect(stuck.status).toBe('IN_PROGRESS')
      expect(stuck.leaseOwner).toBe('worker-that-dies')
      expect(stuck.leaseExpiresAt).not.toBeNull()

      // Nobody may take it while the lease holds.
      const tooSoon = await claimNext(prisma, org.organizationId, new Date(), 'worker-b')
      expect(tooSoon?.id).not.toBe(claimed!.id)

      // Once it expires, it is fair game again.
      const later = new Date(Date.now() + (LEASE_SECONDS + 60) * 1000)
      expect(await countExpiredLeases(prisma, org.organizationId, later)).toBeGreaterThan(0)

      const reclaimed = await claimNext(prisma, org.organizationId, later, 'worker-c')
      expect(reclaimed?.id).toBe(claimed!.id)

      const after = await prisma.syncJob.findUniqueOrThrow({ where: { id: claimed!.id } })
      expect(after.leaseOwner).toBe('worker-c')
      expect(after.reclaimedCount).toBe(1)
    })

    it('reclaims safely: the retry lands on the same QuickBooks document', async () => {
      await sell(3)

      // A worker that reaches QuickBooks and then vanishes — the document is
      // created, the response never arrives, and the lease is never released.
      qbo.failNext('createInvoice', { kind: 'lose-response' })
      await drain({ organizationId: org.organizationId, client: qbo, limit: 50, leaseOwner: 'doomed' })
      expect(qbo.countOf('Invoice')).toBe(1)

      await db(org.ownerCtx).syncJob.updateMany({
        where: { entityType: 'Sale' },
        data: {
          status: 'IN_PROGRESS',
          leaseOwner: 'doomed',
          leaseExpiresAt: new Date(Date.now() - 1000),
        },
      })

      // Another worker picks it up after the lease lapses. Because the request
      // id travels with the job, QuickBooks replays rather than duplicating.
      await drain({ organizationId: org.organizationId, client: qbo, limit: 50, leaseOwner: 'rescuer' })

      expect(qbo.countOf('Invoice')).toBe(1)
      const job = (await jobsFor(org)).find((entry) => entry.entityType === 'Sale')
      expect(job?.status).toBe('SYNCED')
    })

    it('releases the lease on every terminal outcome', async () => {
      await sell(2)
      qbo.failAlways('createCustomer', { kind: 'validation', message: 'Nope' })
      await drain({ organizationId: org.organizationId, client: qbo, limit: 50, leaseOwner: 'w' })

      const prisma = db(org.ownerCtx)
      const jobs = await prisma.syncJob.findMany()
      for (const job of jobs) {
        expect(job.status).not.toBe('IN_PROGRESS')
        expect(job.leaseOwner, `${job.entityType} kept its lease`).toBeNull()
        expect(job.leaseExpiresAt).toBeNull()
      }
      expect(await countExpiredLeases(prisma, org.organizationId)).toBe(0)
    })
  })

  // ── §14 the sweep ─────────────────────────────────────────────────────────

  it('sweeps every connected company and records that it ran', async () => {
    await sell(3)

    const result = await sweep({ perOrganization: 50 })
    expect(result.workerId).toMatch(/^worker-/)
    expect(result.totals.synced).toBeGreaterThan(0)
    expect(result.organizations.some((entry) => entry.organizationId === org.organizationId)).toBe(true)

    const connection = await db(org.ownerCtx).integrationConnection.findFirstOrThrow({
      where: { provider: 'QUICKBOOKS_ONLINE' },
    })
    expect(connection.lastWorkerRunAt).not.toBeNull()
    expect(connection.lastWorkerId).toBe(result.workerId)
  })

  it('carries on past a company whose connection is broken', async () => {
    const other = await createTestOrg()
    try {
      // Connected, but pointed at nothing that works.
      await unsafeDb.integrationConnection.create({
        data: {
          organizationId: other.organizationId,
          provider: 'QUICKBOOKS_ONLINE',
          status: 'CONNECTED',
          environment: 'SANDBOX',
          realmId: null,
        },
      })
      await sell(2)

      const result = await sweep({ perOrganization: 50 })
      // Ours still synced. One broken tenant does not stop the others' books
      // being kept up to date.
      const mine = result.organizations.find((entry) => entry.organizationId === org.organizationId)
      expect(mine?.synced).toBeGreaterThan(0)
      expect(qbo.countOf('Invoice')).toBe(1)
    } finally {
      await unsafeDb.organization.deleteMany({ where: { id: other.organizationId } })
    }
  })

  it('does nothing for a company that is not connected', async () => {
    await db(org.ownerCtx).integrationConnection.updateMany({
      where: { provider: 'QUICKBOOKS_ONLINE' },
      data: { status: 'DISCONNECTED' },
    })
    const result = await sweep({ perOrganization: 50 })
    expect(result.organizations.some((entry) => entry.organizationId === org.organizationId)).toBe(false)
  })

  // ── §19 health from measured state ────────────────────────────────────────

  describe('reporting worker health', () => {
    const office = () => addMember(org, 'office')

    it('says it has not run rather than pretending', async () => {
      const pat = await office()
      const view = await describeConnection(pat.ctx)
      // No SYNC_WORKER_TOKEN is configured in the test environment, and that is
      // reported honestly rather than shown as a reassuring tick.
      expect(view.worker.status).toBe('NOT_CONFIGURED')
      expect(view.worker.detail).toMatch(/no scheduled worker is configured/i)
    })

    it('counts pending, retrying and blocked separately', async () => {
      const pat = await office()
      await sell(2)
      qbo.failAlways('createCustomer', { kind: 'transient' })
      await drain({ organizationId: org.organizationId, client: qbo, limit: 50 })

      const view = await describeConnection(pat.ctx)
      expect(view.health.retrying).toBe(1)
      expect(view.health.blocked).toBe(1)
      expect(view.health.staleLeases).toBe(0)
    })

    it('reports abandoned jobs as a stall', async () => {
      const pat = await office()
      await sell(2)
      await claimNext(db(org.ownerCtx), org.organizationId, new Date(), 'worker-that-dies')
      await db(org.ownerCtx).syncJob.updateMany({
        where: { leaseOwner: 'worker-that-dies' },
        data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
      })

      const view = await describeConnection(pat.ctx)
      expect(view.health.staleLeases).toBe(1)
    })
  })
})
