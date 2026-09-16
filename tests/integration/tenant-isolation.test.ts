import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db, TENANT_MODELS, UNDELETABLE_MODELS } from '@/server/db/tenant'
import { createCustomer, createProduct, createTestOrg, type TestOrg } from '../helpers'

/**
 * The highest-severity bug class in multi-tenant SaaS: one missing
 * `where: { organizationId }` and a distributor sees a competitor's accounts.
 * These tests attempt the leak from every direction (docs/04 §5).
 */
describe('tenant isolation', () => {
  let alpha: TestOrg
  let beta: TestOrg
  let betaCustomerId: string
  let betaProductId: string

  beforeAll(async () => {
    alpha = await createTestOrg('Alpha Distributing')
    beta = await createTestOrg('Beta Snacks')

    // Identical-looking data in both tenants, so a leak cannot hide behind
    // "well, it found nothing because there was nothing to find".
    await createCustomer(alpha.organizationId, "Joe's Marathon")
    const betaCustomer = await createCustomer(beta.organizationId, "Joe's Marathon")
    betaCustomerId = betaCustomer.id

    await createProduct(alpha.organizationId, { sku: 'SHARED-SKU', name: 'Takis Fuego' })
    const betaProduct = await createProduct(beta.organizationId, {
      sku: 'SHARED-SKU',
      name: 'Takis Fuego',
    })
    betaProductId = betaProduct.id
  })

  afterAll(async () => {
    await unsafeDb.organization.deleteMany({
      where: { id: { in: [alpha.organizationId, beta.organizationId] } },
    })
  })

  it('shows each tenant only its own records', async () => {
    const seenByAlpha = await db(alpha.ownerCtx).customer.findMany()
    const seenByBeta = await db(beta.ownerCtx).customer.findMany()

    expect(seenByAlpha).toHaveLength(1)
    expect(seenByBeta).toHaveLength(1)
    expect(seenByAlpha[0].id).not.toBe(seenByBeta[0].id)
  })

  it('returns nothing when one tenant asks for another tenant\'s record by id', async () => {
    expect(await db(alpha.ownerCtx).customer.findFirst({ where: { id: betaCustomerId } })).toBeNull()
    expect(await db(alpha.ownerCtx).product.findFirst({ where: { id: betaProductId } })).toBeNull()
  })

  it('scopes findUnique too, so a leaked id is still useless', async () => {
    // Prisma allows non-unique filters alongside the unique selector; the
    // extension uses that to pin every lookup to the caller's organization.
    const stolen = await db(alpha.ownerCtx).customer.findUnique({ where: { id: betaCustomerId } })
    expect(stolen).toBeNull()
  })

  it('rejects a cross-tenant filter rather than quietly rewriting it', async () => {
    // Silently swapping the id in would be safe but would hand back rows nobody
    // asked for. A service that builds such a query has a bug; say so.
    await expect(
      db(alpha.ownerCtx).customer.findMany({ where: { organizationId: beta.organizationId } }),
    ).rejects.toThrow(/Cross-organization access/i)
  })

  it('refuses to write a record into another organization', async () => {
    await expect(
      db(alpha.ownerCtx).supplier.create({
        data: { organizationId: beta.organizationId, name: 'Smuggled' },
      }),
    ).rejects.toThrow(/another organization/i)

    expect(await unsafeDb.supplier.count({ where: { name: 'Smuggled' } })).toBe(0)
  })

  it('still allows a query that names its own organization', async () => {
    const own = await db(alpha.ownerCtx).customer.findMany({
      where: { organizationId: alpha.organizationId },
    })
    expect(own).toHaveLength(1)
  })

  it('refuses to update another tenant\'s record', async () => {
    const updated = await db(alpha.ownerCtx).customer.updateMany({
      where: { id: betaCustomerId },
      data: { name: 'Hijacked' },
    })
    expect(updated.count).toBe(0)

    const untouched = await unsafeDb.customer.findUnique({
      where: { id: betaCustomerId },
      select: { name: true },
    })
    expect(untouched?.name).toBe("Joe's Marathon")
  })

  it('refuses to delete another tenant\'s record', async () => {
    const deleted = await db(alpha.ownerCtx).customer.deleteMany({ where: { id: betaCustomerId } })
    expect(deleted.count).toBe(0)
    expect(await unsafeDb.customer.count({ where: { id: betaCustomerId } })).toBe(1)
  })

  it('backfills organizationId on a write that omits it', async () => {
    // TypeScript already requires the column, so this guards the loosely-typed
    // call sites: dynamic writes, scripts, and anything reaching Prisma from JS.
    const create = db(alpha.ownerCtx).supplier.create as unknown as (
      args: unknown,
    ) => Promise<{ id: string; organizationId: string }>

    const created = await create({
      data: { name: `Supplier ${Date.now()}` },
      select: { id: true, organizationId: true },
    })
    expect(created.organizationId).toBe(alpha.organizationId)
    await unsafeDb.supplier.delete({ where: { id: created.id } })
  })

  it('counts and aggregates only within the tenant', async () => {
    expect(await db(alpha.ownerCtx).customer.count()).toBe(1)
    expect(await db(beta.ownerCtx).product.count()).toBe(1)
  })

  it('never deletes financial history, even for its own tenant', async () => {
    await expect(db(alpha.ownerCtx).sale.deleteMany({ where: {} })).rejects.toThrow(
      /never deleted/i,
    )
    await expect(
      db(alpha.ownerCtx).inventoryTransaction.deleteMany({ where: {} }),
    ).rejects.toThrow(/never deleted/i)
  })

  it('leaves non-tenant models alone', async () => {
    // User is global identity; scoping it by organization would break login.
    const users = await db(alpha.ownerCtx).user.findMany({ where: { id: beta.ownerUserId } })
    expect(users).toHaveLength(1)
  })
})

describe('TENANT_MODELS stays in step with the schema', () => {
  /**
   * A new model added with an organizationId but not listed here would silently
   * bypass the extension. This reads the schema so that mistake fails the build
   * rather than shipping.
   */
  it('lists exactly the models that carry organizationId', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8')
    const blocks = schema.split(/^model\s+/m).slice(1)

    const withOrgId = blocks
      .map((block) => ({
        name: block.slice(0, block.indexOf(' ')).trim(),
        body: block.slice(0, block.indexOf('\n}')),
      }))
      .filter((mm) => /^\s+organizationId\s+String/m.test(mm.body))
      .map((mm) => mm.name)
      .sort()

    expect(withOrgId).toEqual([...TENANT_MODELS].sort())
  })

  it('protects every financial model from deletion', () => {
    for (const model of UNDELETABLE_MODELS) {
      expect(TENANT_MODELS).toContain(model)
    }
  })
})
