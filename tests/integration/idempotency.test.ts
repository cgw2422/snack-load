import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { postInventoryTransaction } from '@/server/services/inventory.service'
import { createCustomer, createProduct, createTestOrg, type TestOrg } from '../helpers'

/**
 * A runner in a rural store submits a sale, the request times out, the app
 * retries. The store must be billed once (docs/02 §I1). The schema-level
 * guarantee is a unique index on (organizationId, idempotencyKey); these tests
 * prove it holds for every financial document.
 */
describe('idempotency', () => {
  let org: TestOrg
  let customerId: string
  let product: Awaited<ReturnType<typeof createProduct>>

  beforeAll(async () => {
    org = await createTestOrg()
    customerId = (await createCustomer(org.organizationId)).id
    product = await createProduct(org.organizationId)
  })

  afterAll(async () => {
    await unsafeDb.organization.delete({ where: { id: org.organizationId } })
  })

  const saleData = (idempotencyKey: string, saleNumber: string) => ({
    organizationId: org.organizationId,
    saleNumber,
    customerId,
    soldByUserId: org.ownerUserId,
    status: 'COMPLETED' as const,
    subtotal: '185.50',
    total: '185.50',
    balanceDue: '0',
    idempotencyKey,
  })

  it('refuses a second sale carrying the same key', async () => {
    const key = 'cart-4f2a-9b1c'
    await unsafeDb.sale.create({ data: saleData(key, 'S-01001') })

    await expect(unsafeDb.sale.create({ data: saleData(key, 'S-01002') })).rejects.toThrow()

    expect(await unsafeDb.sale.count({ where: { organizationId: org.organizationId } })).toBe(1)
  })

  it('lets a different organization use the same key', async () => {
    const other = await createTestOrg()
    const otherCustomer = await createCustomer(other.organizationId)

    await unsafeDb.sale.create({
      data: {
        organizationId: other.organizationId,
        saleNumber: 'S-01001',
        customerId: otherCustomer.id,
        soldByUserId: other.ownerUserId,
        status: 'COMPLETED',
        subtotal: '10.00',
        total: '10.00',
        balanceDue: '0',
        idempotencyKey: 'cart-4f2a-9b1c',
      },
    })

    expect(await unsafeDb.sale.count({ where: { organizationId: other.organizationId } })).toBe(1)
    await unsafeDb.organization.delete({ where: { id: other.organizationId } })
  })

  it('refuses a replayed payment', async () => {
    const key = 'pay-88c1'
    const data = {
      organizationId: org.organizationId,
      customerId,
      method: 'CASH' as const,
      amount: '185.50',
      receivedByUserId: org.ownerUserId,
      idempotencyKey: key,
    }
    await unsafeDb.payment.create({ data })
    await expect(unsafeDb.payment.create({ data })).rejects.toThrow()
    expect(await unsafeDb.payment.count({ where: { organizationId: org.organizationId } })).toBe(1)
  })

  it('refuses a replayed inventory posting', async () => {
    const key = 'post-1234'
    const post = () =>
      unsafeDb.$transaction((tx) =>
        postInventoryTransaction(tx, org.organizationId, {
          type: 'SUPPLIER_RECEIPT',
          idempotencyKey: key,
          lines: [
            {
              productId: product.id,
              locationId: org.warehouseLocationId,
              quantityDelta: 120,
              unitCost: '1.200000',
            },
          ],
        }),
      )

    await post()
    await expect(post()).rejects.toThrow()

    // The retry must not have moved any stock a second time.
    const balance = await unsafeDb.inventoryBalance.findUnique({
      where: { locationId_productId: { locationId: org.warehouseLocationId, productId: product.id } },
      select: { quantity: true },
    })
    expect(balance?.quantity).toBe(120)
  })

  it('keeps document numbers unique within a company', async () => {
    await expect(
      unsafeDb.sale.create({ data: saleData('a-different-key', 'S-01001') }),
    ).rejects.toThrow()
  })
})
