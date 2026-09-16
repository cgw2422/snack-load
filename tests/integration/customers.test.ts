import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import {
  bulkUpdateCustomers,
  createCustomer,
  getCustomer,
  listCustomers,
  setCustomerActive,
} from '@/server/services/customer.service'
import { addMember, createTestOrg, type TestOrg } from '../helpers'

/** Bulk account management (spec §11): what an admin does the hour after an import. */
describe('customer accounts', () => {
  let org: TestOrg
  let ids: string[]
  let routeA: string
  let routeB: string

  beforeEach(async () => {
    org = await createTestOrg()
    const prisma = db(org.ownerCtx)

    const a = await prisma.routeTemplate.create({
      data: { organizationId: org.organizationId, name: 'Route A', dayOfWeek: 'TUESDAY' },
      select: { id: true },
    })
    const b = await prisma.routeTemplate.create({
      data: { organizationId: org.organizationId, name: 'Route B', dayOfWeek: 'WEDNESDAY' },
      select: { id: true },
    })
    routeA = a.id
    routeB = b.id

    ids = []
    for (const name of ["Joe's Marathon", 'Speedway #214', 'BellStores']) {
      const created = await createCustomer(org.ownerCtx, {
        accountNumber: '',
        name,
        paymentTermsCode: 'COD',
        taxExempt: false,
        active: true,
      })
      ids.push(created.id)
    }
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  it('numbers an account automatically when the form leaves it blank', async () => {
    const customers = await db(org.ownerCtx).customer.findMany({ select: { accountNumber: true } })
    expect(customers).toHaveLength(3)
    expect(new Set(customers.map((c) => c.accountNumber)).size).toBe(3)
    expect(customers.every((c) => c.accountNumber.length > 0)).toBe(true)
  })

  it('assigns a whole selection to a route in one action', async () => {
    const result = await bulkUpdateCustomers(org.ownerCtx, {
      customerIds: ids,
      action: 'assign_route',
      routeTemplateId: routeA,
    })
    expect(result.updated).toBe(3)

    const schedules = await db(org.ownerCtx).customerSchedule.findMany()
    expect(schedules).toHaveLength(3)
    // The route's own day is inherited when the action does not name one.
    expect(schedules.every((s) => s.dayOfWeek === 'TUESDAY')).toBe(true)
  })

  it('moves a selection between routes without leaving two schedules behind', async () => {
    await bulkUpdateCustomers(org.ownerCtx, {
      customerIds: ids, action: 'assign_route', routeTemplateId: routeA,
    })
    await bulkUpdateCustomers(org.ownerCtx, {
      customerIds: ids, action: 'assign_route', routeTemplateId: routeB,
    })

    const schedules = await db(org.ownerCtx).customerSchedule.findMany()
    expect(schedules).toHaveLength(3)
    expect(schedules.every((s) => s.routeTemplateId === routeB)).toBe(true)
  })

  it('changes the visit day for a selection', async () => {
    await bulkUpdateCustomers(org.ownerCtx, {
      customerIds: ids, action: 'assign_route', routeTemplateId: routeA,
    })
    await bulkUpdateCustomers(org.ownerCtx, {
      customerIds: ids, action: 'set_visit_day', dayOfWeek: 'FRIDAY',
    })

    const schedules = await db(org.ownerCtx).customerSchedule.findMany()
    expect(schedules.every((s) => s.dayOfWeek === 'FRIDAY')).toBe(true)
  })

  it('assigns a runner by moving accounts onto the route they drive', async () => {
    const mike = await addMember(org, 'runner')
    await db(org.ownerCtx).routeTemplate.update({
      where: { id: routeB },
      data: { defaultRunnerUserId: mike.userId },
    })

    await bulkUpdateCustomers(org.ownerCtx, {
      customerIds: ids, action: 'assign_runner', runnerUserId: mike.userId,
    })

    const schedules = await db(org.ownerCtx).customerSchedule.findMany()
    expect(schedules.every((s) => s.routeTemplateId === routeB)).toBe(true)
  })

  it('refuses to assign a runner who has no route, and says what to do', async () => {
    const sarah = await addMember(org, 'runner')
    await expect(
      bulkUpdateCustomers(org.ownerCtx, {
        customerIds: ids, action: 'assign_runner', runnerUserId: sarah.userId,
      }),
    ).rejects.toThrow(/no route yet/i)
  })

  it('changes payment terms in bulk', async () => {
    await bulkUpdateCustomers(org.ownerCtx, {
      customerIds: ids, action: 'set_terms', paymentTermsCode: 'NET30',
    })
    const customers = await db(org.ownerCtx).customer.findMany()
    expect(customers.every((c) => c.paymentTermsCode === 'NET30')).toBe(true)
  })

  it('will not hide a debt by deactivating an account that owes money', async () => {
    await db(org.ownerCtx).customer.update({
      where: { id: ids[0] },
      data: { balance: '312.50' },
    })

    await expect(setCustomerActive(org.ownerCtx, ids[0], false)).rejects.toThrow(/still owes/i)

    const result = await bulkUpdateCustomers(org.ownerCtx, {
      customerIds: ids,
      action: 'deactivate',
    })
    expect(result.updated).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.message).toMatch(/open balance/i)

    const stillActive = await db(org.ownerCtx).customer.findFirst({ where: { id: ids[0] } })
    expect(stillActive?.active).toBe(true)
  })

  it('ignores ids belonging to another company', async () => {
    const other = await createTestOrg()
    const theirs = await createCustomer(other.ownerCtx, {
      accountNumber: 'X-1',
      name: 'Not Yours',
      paymentTermsCode: 'COD',
      taxExempt: false,
      active: true,
    })

    const result = await bulkUpdateCustomers(org.ownerCtx, {
      customerIds: [...ids, theirs.id],
      action: 'set_terms',
      paymentTermsCode: 'NET15',
    })
    expect(result.updated).toBe(3)
    expect(result.skipped).toBe(1)

    const untouched = await db(other.ownerCtx).customer.findFirst({ where: { id: theirs.id } })
    expect(untouched?.paymentTermsCode).toBe('COD')

    await unsafeDb.organization.delete({ where: { id: other.organizationId } })
  })

  it('writes an audit entry naming what was done and to how many', async () => {
    await bulkUpdateCustomers(org.ownerCtx, {
      customerIds: ids, action: 'set_terms', paymentTermsCode: 'NET30',
    })
    const entry = await db(org.ownerCtx).auditLog.findFirst({
      where: { action: 'customer.bulk_set_terms' },
    })
    expect(entry).not.toBeNull()
    expect((entry!.afterJson as Record<string, unknown>).count).toBe(3)
  })

  it('reports lifetime and average order alongside the open balance', async () => {
    const detail = await getCustomer(org.ownerCtx, ids[0])
    expect(detail.stats).toMatchObject({
      lifetimeSales: '0.00',
      averageOrder: '0.00',
      orderCount: 0,
      openBalance: '0.00',
    })
  })

  it('searches by name, account number and city', async () => {
    const byName = await listCustomers(org.ownerCtx, {
      search: 'speedway', status: 'active', page: 1, pageSize: 50,
    })
    expect(byName.items).toHaveLength(1)
    expect(byName.items[0].name).toBe('Speedway #214')

    const nothing = await listCustomers(org.ownerCtx, {
      search: 'zzzz', status: 'active', page: 1, pageSize: 50,
    })
    expect(nothing.items).toHaveLength(0)
  })

  it('pages a long list without shipping all of it', async () => {
    const page = await listCustomers(org.ownerCtx, {
      status: 'active', page: 1, pageSize: 2,
    })
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(3)
    expect(page.pageCount).toBe(2)
  })
})
