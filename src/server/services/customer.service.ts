import { Prisma } from '@/generated/prisma/client'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'
import { m, toAmountString } from '@/server/domain/money'
import { nextDocumentNumber } from './inventory.service'
import { changedFields, writeAudit } from './audit.service'
import type {
  BulkCustomerAction,
  CustomerInput,
  ListQuery,
} from '@/lib/schemas/catalog'
import type { Paged } from './product.service'

/**
 * Customer accounts — gas stations, convenience stores, small markets. The
 * screen a runner opens at a stop, and the one an owner sorts by what they owe.
 */

export type CustomerListItem = {
  id: string
  accountNumber: string
  name: string
  parentCompany: string | null
  city: string | null
  state: string | null
  addressLine: string
  phone: string | null
  active: boolean
  balance: string
  creditLimit: string | null
  overCreditLimit: boolean
  paymentTermsCode: string
  routeName: string | null
  runnerName: string | null
  visitDay: string | null
  lastVisitAt: string | null
}

export type CustomerDetail = CustomerListItem & {
  email: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  latitude: string | null
  longitude: string | null
  mapQuery: string
  taxExempt: boolean
  taxExemptId: string | null
  priceGroupId: string | null
  priceGroupName: string | null
  taxRateId: string | null
  notes: string | null
  deliveryInstructions: string | null
  contacts: { id: string; name: string; title: string | null; phone: string | null; email: string | null; isPrimary: boolean }[]
  schedule: { routeTemplateId: string; routeName: string; dayOfWeek: string; frequency: string; sequence: number } | null
  /** What this account actually buys — drives the suggested order at a stop. */
  stats: {
    lifetimeSales: string
    averageOrder: string
    orderCount: number
    openBalance: string
    lastOrderAt: string | null
  }
  recentSales: { id: string; saleNumber: string; occurredAt: string; total: string; balanceDue: string }[]
  topProducts: { productId: string; name: string; sku: string; quantity: number; uomLabel: string }[]
}

const SORTS: Record<string, Prisma.CustomerOrderByWithRelationInput[]> = {
  name: [{ name: 'asc' }],
  account: [{ accountNumber: 'asc' }],
  balance: [{ balance: 'desc' }],
  recent: [{ lastVisitAt: 'desc' }],
}

export async function listCustomers(
  ctx: AuthContext,
  query: ListQuery,
): Promise<Paged<CustomerListItem>> {
  requirePermission(ctx, 'customer:read')
  const prisma = db(ctx)

  const where: Prisma.CustomerWhereInput = {
    ...(query.status === 'all' ? {} : { active: query.status === 'active' }),
    ...(query.routeTemplateId
      ? { schedules: { some: { routeTemplateId: query.routeTemplateId, active: true } } }
      : {}),
    ...(query.runnerUserId
      ? {
          schedules: {
            some: { active: true, routeTemplate: { defaultRunnerUserId: query.runnerUserId } },
          },
        }
      : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { accountNumber: { contains: query.search, mode: 'insensitive' } },
            { city: { contains: query.search, mode: 'insensitive' } },
            { parentCompany: { contains: query.search, mode: 'insensitive' } },
            { phone: { contains: query.search } },
          ],
        }
      : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: SORTS[query.sort ?? 'name'] ?? SORTS.name,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: customerListSelect,
    }),
  ])

  return {
    items: rows.map(toListItem),
    total,
    page: query.page,
    pageSize: query.pageSize,
    pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}

export async function getCustomer(ctx: AuthContext, id: string): Promise<CustomerDetail> {
  requirePermission(ctx, 'customer:read')
  const prisma = db(ctx)

  const customer = await prisma.customer.findFirst({
    where: { id },
    select: {
      ...customerListSelect,
      email: true,
      addressLine2: true,
      latitude: true,
      longitude: true,
      taxExempt: true,
      taxExemptId: true,
      taxRateId: true,
      priceGroupId: true,
      priceGroup: { select: { name: true } },
      notes: true,
      deliveryInstructions: true,
      contacts: {
        orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, title: true, phone: true, email: true, isPrimary: true },
      },
    },
  })
  if (!customer) throw notFound('Customer')

  const [aggregate, openBalance, recentSales, topProducts] = await Promise.all([
    prisma.sale.aggregate({
      where: { customerId: id, status: 'COMPLETED' },
      _sum: { total: true },
      _count: true,
      _max: { occurredAt: true },
    }),
    prisma.sale.aggregate({
      where: { customerId: id, status: 'COMPLETED', balanceDue: { gt: 0 } },
      _sum: { balanceDue: true },
    }),
    prisma.sale.findMany({
      where: { customerId: id, status: { not: 'DRAFT' } },
      orderBy: { occurredAt: 'desc' },
      take: 8,
      select: { id: true, saleNumber: true, occurredAt: true, total: true, balanceDue: true, status: true },
    }),
    prisma.saleItem.groupBy({
      by: ['productId', 'productNameSnapshot', 'skuSnapshot', 'uomLabelSnapshot'],
      where: { sale: { customerId: id, status: 'COMPLETED' } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 6,
    }),
  ])

  const base = toListItem(customer)
  const orderCount = aggregate._count
  const lifetime = m(aggregate._sum.total ?? 0)

  return {
    ...base,
    email: customer.email,
    addressLine1: customer.addressLine1,
    addressLine2: customer.addressLine2,
    postalCode: customer.postalCode,
    latitude: customer.latitude?.toString() ?? null,
    longitude: customer.longitude?.toString() ?? null,
    mapQuery:
      customer.latitude && customer.longitude
        ? `${customer.latitude},${customer.longitude}`
        : base.addressLine,
    taxExempt: customer.taxExempt,
    taxExemptId: customer.taxExemptId,
    priceGroupId: customer.priceGroupId,
    priceGroupName: customer.priceGroup?.name ?? null,
    taxRateId: customer.taxRateId,
    notes: customer.notes,
    deliveryInstructions: customer.deliveryInstructions,
    contacts: customer.contacts,
    schedule: customer.schedules[0]
      ? {
          routeTemplateId: customer.schedules[0].routeTemplateId,
          routeName: customer.schedules[0].routeTemplate.name,
          dayOfWeek: customer.schedules[0].dayOfWeek,
          frequency: customer.schedules[0].frequency,
          sequence: customer.schedules[0].sequence,
        }
      : null,
    stats: {
      lifetimeSales: toAmountString(lifetime),
      averageOrder: toAmountString(orderCount > 0 ? lifetime.dividedBy(orderCount) : 0),
      orderCount,
      openBalance: toAmountString(openBalance._sum.balanceDue ?? 0),
      lastOrderAt: aggregate._max.occurredAt?.toISOString() ?? null,
    },
    recentSales: recentSales.map((s) => ({
      id: s.id,
      saleNumber: s.saleNumber,
      occurredAt: s.occurredAt.toISOString(),
      total: toAmountString(s.total),
      balanceDue: toAmountString(s.balanceDue),
    })),
    topProducts: topProducts.map((p) => ({
      productId: p.productId,
      name: p.productNameSnapshot,
      sku: p.skuSnapshot,
      quantity: p._sum.quantity ?? 0,
      uomLabel: p.uomLabelSnapshot,
    })),
  }
}

export async function createCustomer(
  ctx: AuthContext,
  input: CustomerInput,
): Promise<{ id: string; accountNumber: string }> {
  requirePermission(ctx, 'customer:create')
  const prisma = db(ctx)

  return prisma.$transaction(async (tx) => {
    // An account number is optional to the user; if they leave it blank the
    // company's sequence supplies one rather than failing the form.
    const accountNumber = input.accountNumber || (await nextDocumentNumber(tx, ctx.organizationId, 'CUSTOMER'))

    const clash = await tx.customer.findFirst({
      where: { organizationId: ctx.organizationId, accountNumber },
      select: { name: true },
    })
    if (clash) throw conflict(`Account number ${accountNumber} is already used by ${clash.name}.`)

    const customer = await tx.customer.create({
      data: {
        organizationId: ctx.organizationId,
        ...scalarFields(input),
        accountNumber,
        ...(input.contactName
          ? {
              contacts: {
                create: {
                  organizationId: ctx.organizationId,
                  name: input.contactName,
                  phone: input.phone || null,
                  email: input.email || null,
                  isPrimary: true,
                },
              },
            }
          : {}),
      },
      select: { id: true, accountNumber: true, name: true },
    })

    await writeAudit(tx, ctx, {
      action: 'customer.created',
      entityType: 'Customer',
      entityId: customer.id,
      after: { accountNumber: customer.accountNumber, name: customer.name },
    })

    return { id: customer.id, accountNumber: customer.accountNumber }
  })
}

export async function updateCustomer(
  ctx: AuthContext,
  id: string,
  input: CustomerInput,
): Promise<void> {
  requirePermission(ctx, 'customer:update')
  const prisma = db(ctx)

  const existing = await prisma.customer.findFirst({ where: { id } })
  if (!existing) throw notFound('Customer')

  const clash = await prisma.customer.findFirst({
    where: { accountNumber: input.accountNumber, NOT: { id } },
    select: { name: true },
  })
  if (clash) throw conflict(`Account number ${input.accountNumber} is already used by ${clash.name}.`)

  await prisma.$transaction(async (tx) => {
    const next = { ...scalarFields(input), accountNumber: input.accountNumber }
    await tx.customer.update({ where: { id }, data: next })

    const diff = changedFields(
      existing as unknown as Record<string, unknown>,
      next as Record<string, unknown>,
    )
    if (Object.keys(diff.after).length > 0) {
      await writeAudit(tx, ctx, {
        action: 'customer.updated',
        entityType: 'Customer',
        entityId: id,
        before: diff.before,
        after: diff.after,
      })
    }
  })
}

export async function setCustomerActive(
  ctx: AuthContext,
  id: string,
  active: boolean,
): Promise<void> {
  requirePermission(ctx, active ? 'customer:update' : 'customer:deactivate')
  const prisma = db(ctx)

  const existing = await prisma.customer.findFirst({
    where: { id },
    select: { active: true, balance: true, name: true },
  })
  if (!existing) throw notFound('Customer')

  // Deactivating an account that still owes money would hide the debt from the
  // AR report. Say so rather than quietly losing it.
  if (!active && m(existing.balance).greaterThan(0)) {
    throw conflict(
      `${existing.name} still owes ${toAmountString(existing.balance)}. Settle or write off the balance first.`,
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.customer.update({ where: { id }, data: { active } })
    await writeAudit(tx, ctx, {
      action: active ? 'customer.reactivated' : 'customer.deactivated',
      entityType: 'Customer',
      entityId: id,
      before: { active: existing.active },
      after: { active },
    })
  })
}

/**
 * Bulk account management (spec §11). After an import of 400 stores, an admin
 * needs to put them all on Tuesday's route without opening 400 screens.
 */
export async function bulkUpdateCustomers(
  ctx: AuthContext,
  input: BulkCustomerAction,
): Promise<{ updated: number; skipped: number; message: string }> {
  requirePermission(ctx, input.action === 'deactivate' ? 'customer:deactivate' : 'customer:update')
  const prisma = db(ctx)

  // Scope the ids to this tenant before doing anything with them.
  const targets = await prisma.customer.findMany({
    where: { id: { in: input.customerIds } },
    select: { id: true, name: true, balance: true, active: true },
  })
  if (targets.length === 0) throw notFound('Those stores')

  const ids = targets.map((t) => t.id)
  let updated = 0
  let skipped = input.customerIds.length - targets.length
  let message = ''

  await prisma.$transaction(async (tx) => {
    switch (input.action) {
      case 'set_terms': {
        if (!input.paymentTermsCode) throw conflict('Choose payment terms.')
        const r = await tx.customer.updateMany({
          where: { id: { in: ids } },
          data: { paymentTermsCode: input.paymentTermsCode },
        })
        updated = r.count
        message = `Payment terms set to ${input.paymentTermsCode}`
        break
      }
      case 'set_price_group': {
        const r = await tx.customer.updateMany({
          where: { id: { in: ids } },
          data: { priceGroupId: input.priceGroupId || null },
        })
        updated = r.count
        message = input.priceGroupId ? 'Pricing group applied' : 'Pricing group removed'
        break
      }
      case 'activate': {
        const r = await tx.customer.updateMany({ where: { id: { in: ids } }, data: { active: true } })
        updated = r.count
        message = 'Accounts activated'
        break
      }
      case 'deactivate': {
        // Same rule as the single-record path: a debt must not be hidden.
        const owing = targets.filter((t) => m(t.balance).greaterThan(0))
        const safe = targets.filter((t) => !m(t.balance).greaterThan(0)).map((t) => t.id)
        const r = await tx.customer.updateMany({ where: { id: { in: safe } }, data: { active: false } })
        updated = r.count
        skipped += owing.length
        message =
          owing.length > 0
            ? `Deactivated ${r.count}. Skipped ${owing.length} with an open balance.`
            : 'Accounts deactivated'
        break
      }
      case 'assign_route':
      case 'set_visit_day':
      case 'set_frequency':
      case 'assign_runner': {
        updated = await applyScheduleChange(tx, ctx, ids, input)
        message = {
          assign_route: 'Route assigned',
          set_visit_day: 'Visit day changed',
          set_frequency: 'Visit frequency changed',
          assign_runner: 'Runner assigned',
        }[input.action]
        break
      }
    }

    await writeAudit(tx, ctx, {
      action: `customer.bulk_${input.action}`,
      entityType: 'Customer',
      entityId: `${updated} accounts`,
      after: { action: input.action, count: updated, ...bulkAuditPayload(input) },
    })
  })

  return { updated, skipped, message }
}

// ── internals ────────────────────────────────────────────────────────────────

type BulkTx = Parameters<Parameters<ReturnType<typeof db>['$transaction']>[0]>[0]

async function applyScheduleChange(
  tx: BulkTx,
  ctx: AuthContext,
  ids: string[],
  input: BulkCustomerAction,
): Promise<number> {
  // Assigning a runner means moving accounts onto the route that runner drives:
  // runners are assigned to routes, and accounts to routes, never directly to a
  // person. Doing it the other way would leave the route schedule inconsistent.
  let routeTemplateId = input.routeTemplateId

  if (input.action === 'assign_runner') {
    if (!input.runnerUserId) throw conflict('Choose a runner.')
    const route = await tx.routeTemplate.findFirst({
      where: { defaultRunnerUserId: input.runnerUserId, active: true },
      select: { id: true },
      orderBy: { name: 'asc' },
    })
    if (!route) {
      throw conflict(
        'That runner has no route yet. Create a route for them first, then assign stores to it.',
      )
    }
    routeTemplateId = route.id
  }

  if ((input.action === 'assign_route' || input.action === 'assign_runner') && !routeTemplateId) {
    throw conflict('Choose a route.')
  }

  const template = routeTemplateId
    ? await tx.routeTemplate.findFirst({
        where: { id: routeTemplateId },
        select: { id: true, dayOfWeek: true },
      })
    : null

  if (routeTemplateId && !template) throw notFound('Route')

  const existing = await tx.customerSchedule.findMany({
    where: { customerId: { in: ids } },
    select: { id: true, customerId: true },
  })
  const byCustomer = new Map(existing.map((s) => [s.customerId, s.id]))

  let updated = 0
  for (const customerId of ids) {
    const scheduleId = byCustomer.get(customerId)

    const data = {
      ...(template ? { routeTemplateId: template.id } : {}),
      ...(input.dayOfWeek ? { dayOfWeek: input.dayOfWeek } : {}),
      ...(input.frequency ? { frequency: input.frequency } : {}),
      active: true,
    }

    if (scheduleId) {
      await tx.customerSchedule.update({ where: { id: scheduleId }, data })
      updated += 1
    } else if (template) {
      await tx.customerSchedule.create({
        data: {
          organizationId: ctx.organizationId,
          customerId,
          routeTemplateId: template.id,
          dayOfWeek: input.dayOfWeek ?? template.dayOfWeek ?? 'MONDAY',
          frequency: input.frequency ?? 'WEEKLY',
        },
      })
      updated += 1
    }
    // An account with no schedule and no route named cannot have its visit day
    // changed — there is nothing to change it on. It is counted as skipped.
  }

  return updated
}

function bulkAuditPayload(input: BulkCustomerAction) {
  return {
    routeTemplateId: input.routeTemplateId,
    runnerUserId: input.runnerUserId,
    dayOfWeek: input.dayOfWeek,
    frequency: input.frequency,
    paymentTermsCode: input.paymentTermsCode,
    priceGroupId: input.priceGroupId,
  }
}

const customerListSelect = {
  id: true,
  accountNumber: true,
  name: true,
  parentCompany: true,
  addressLine1: true,
  city: true,
  state: true,
  postalCode: true,
  phone: true,
  active: true,
  balance: true,
  creditLimit: true,
  paymentTermsCode: true,
  lastVisitAt: true,
  schedules: {
    where: { active: true },
    take: 1,
    select: {
      routeTemplateId: true,
      dayOfWeek: true,
      frequency: true,
      sequence: true,
      routeTemplate: {
        select: {
          name: true,
          defaultRunner: { select: { firstName: true, lastName: true } },
        },
      },
    },
  },
} satisfies Prisma.CustomerSelect

type CustomerRow = Prisma.CustomerGetPayload<{ select: typeof customerListSelect }>

function toListItem(customer: CustomerRow): CustomerListItem {
  const schedule = customer.schedules[0]
  const runner = schedule?.routeTemplate.defaultRunner

  return {
    id: customer.id,
    accountNumber: customer.accountNumber,
    name: customer.name,
    parentCompany: customer.parentCompany,
    city: customer.city,
    state: customer.state,
    addressLine: [
      customer.addressLine1,
      [customer.city, customer.state].filter(Boolean).join(', '),
      customer.postalCode,
    ]
      .filter(Boolean)
      .join(' · '),
    phone: customer.phone,
    active: customer.active,
    balance: toAmountString(customer.balance),
    creditLimit: customer.creditLimit ? toAmountString(customer.creditLimit) : null,
    overCreditLimit: customer.creditLimit
      ? m(customer.balance).greaterThan(m(customer.creditLimit))
      : false,
    paymentTermsCode: customer.paymentTermsCode,
    routeName: schedule?.routeTemplate.name ?? null,
    runnerName: runner ? `${runner.firstName} ${runner.lastName}`.trim() : null,
    visitDay: schedule?.dayOfWeek ?? null,
    lastVisitAt: customer.lastVisitAt?.toISOString() ?? null,
  }
}

function scalarFields(input: CustomerInput) {
  return {
    name: input.name,
    parentCompany: input.parentCompany || null,
    addressLine1: input.addressLine1 || null,
    addressLine2: input.addressLine2 || null,
    city: input.city || null,
    state: input.state || null,
    postalCode: input.postalCode || null,
    latitude: input.latitude?.toString() ?? null,
    longitude: input.longitude?.toString() ?? null,
    phone: input.phone || null,
    email: input.email || null,
    priceGroupId: input.priceGroupId || null,
    paymentTermsCode: input.paymentTermsCode,
    creditLimit: input.creditLimit || null,
    taxExempt: input.taxExempt,
    taxExemptId: input.taxExemptId || null,
    taxRateId: input.taxRateId || null,
    deliveryInstructions: input.deliveryInstructions || null,
    notes: input.notes || null,
    active: input.active,
  }
}
