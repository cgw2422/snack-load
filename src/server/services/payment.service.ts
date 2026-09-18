import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'
import { m, round2, sum, toAmountString } from '@/server/domain/money'
import {
  allocateOldestFirst,
  allocateSpecific,
  assertAllocationIdentity,
  AllocationError,
} from '@/server/domain/allocation'
import { writeAudit } from './audit.service'
import { enqueueIfConnected } from '@/server/integrations/quickbooks/sync/hooks'
import type { RecordPaymentInput } from '@/lib/schemas/sales'

/**
 * Receivables (spec §25, §26).
 *
 * A payment is money in; where it lands is a separate decision, made by the
 * allocation rules in docs/02 §A3. Both happen in one transaction so a payment
 * can never exist without its allocations adding up.
 */

export type PaymentResult = {
  paymentId: string
  amount: string
  applied: string
  unapplied: string
  clearedInvoices: number
  replayed: boolean
}

export async function recordPayment(
  ctx: AuthContext,
  input: RecordPaymentInput,
): Promise<PaymentResult> {
  requirePermission(ctx, 'payment:create')
  const prisma = db(ctx)

  const replay = await prisma.payment.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, amount: true, unappliedAmount: true },
  })
  if (replay) {
    return {
      paymentId: replay.id,
      amount: toAmountString(replay.amount),
      applied: toAmountString(m(replay.amount).minus(m(replay.unappliedAmount))),
      unapplied: toAmountString(replay.unappliedAmount),
      clearedInvoices: 0,
      replayed: true,
    }
  }

  const amount = round2(input.amount)
  if (amount.lessThanOrEqualTo(0)) throw conflict('Enter how much was paid.')

  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId },
    select: { id: true, name: true },
  })
  if (!customer) throw notFound('That store')

  const open = await prisma.sale.findMany({
    where: { customerId: customer.id, status: 'COMPLETED', balanceDue: { gt: 0 } },
    orderBy: [{ dueDate: 'asc' }, { occurredAt: 'asc' }],
    select: { id: true, balanceDue: true, dueDate: true, occurredAt: true },
  })

  const invoices = open.map((sale) => ({
    saleId: sale.id,
    balanceDue: sale.balanceDue.toString(),
    dueDate: sale.dueDate ?? sale.occurredAt,
    occurredAt: sale.occurredAt,
  }))

  let result
  try {
    result =
      input.strategy === 'SPECIFIC'
        ? allocateSpecific(amount, input.allocations ?? [], invoices)
        : allocateOldestFirst(amount, invoices)
    assertAllocationIdentity(amount, result)
  } catch (error) {
    if (error instanceof AllocationError) throw conflict(error.message)
    throw error
  }

  if (input.strategy === 'SPECIFIC' && requiresAllocation(input)) {
    throw conflict('Choose which invoices this payment should be applied to.')
  }

  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        organizationId: ctx.organizationId,
        customerId: customer.id,
        method: input.method,
        amount: toAmountString(amount),
        unappliedAmount: toAmountString(result.unapplied),
        receivedAt: new Date(),
        receivedByUserId: ctx.userId,
        routeStopId: input.routeStopId || null,
        checkNumber: input.checkNumber || null,
        referenceNumber: input.referenceNumber || null,
        notes: input.notes || null,
        idempotencyKey: input.idempotencyKey,
      },
      select: { id: true },
    })

    let cleared = 0
    for (const allocation of result.allocations) {
      await tx.paymentAllocation.create({
        data: {
          organizationId: ctx.organizationId,
          paymentId: payment.id,
          saleId: allocation.saleId,
          amount: toAmountString(allocation.amount),
        },
      })

      const sale = await tx.sale.findFirst({
        where: { id: allocation.saleId },
        select: { amountPaid: true, balanceDue: true },
      })
      if (!sale) continue

      const nextBalance = m(sale.balanceDue).minus(allocation.amount)
      await tx.sale.update({
        where: { id: allocation.saleId },
        data: {
          amountPaid: toAmountString(m(sale.amountPaid).plus(allocation.amount)),
          balanceDue: toAmountString(nextBalance),
        },
      })
      if (nextBalance.lessThanOrEqualTo(0)) cleared += 1
    }

    // The customer balance drops by what was applied; an over-payment sits on
    // the payment as credit rather than making the balance negative.
    const applied = sum(result.allocations.map((a) => a.amount))
    if (applied.greaterThan(0)) {
      await tx.customer.update({
        where: { id: customer.id },
        data: { balance: { decrement: toAmountString(applied) } },
      })
    }

    await enqueueIfConnected(tx, ctx.organizationId, {
      entityType: 'Payment',
      localId: payment.id,
      operation: 'CREATE',
    })

    await writeAudit(tx, ctx, {
      action: 'payment.recorded',
      entityType: 'Payment',
      entityId: payment.id,
      after: {
        customerName: customer.name,
        amount: toAmountString(amount),
        method: input.method,
        applied: toAmountString(applied),
        unapplied: toAmountString(result.unapplied),
      },
    })

    return {
      paymentId: payment.id,
      amount: toAmountString(amount),
      applied: toAmountString(applied),
      unapplied: toAmountString(result.unapplied),
      clearedInvoices: cleared,
      replayed: false,
    }
  })
}

/** Reversal, not deletion (docs/02 §A4). Both rows stay visible in history. */
export async function reversePayment(
  ctx: AuthContext,
  paymentId: string,
  reason: string,
): Promise<void> {
  requirePermission(ctx, 'payment:void')
  const prisma = db(ctx)

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId },
    select: {
      id: true, status: true, amount: true, customerId: true, method: true,
      allocations: { select: { id: true, saleId: true, amount: true } },
    },
  })
  if (!payment) throw notFound('That payment')
  if (payment.status !== 'POSTED') throw conflict('That payment has already been reversed.')

  await prisma.$transaction(async (tx) => {
    let restored = m(0)

    for (const allocation of payment.allocations) {
      if (m(allocation.amount).lessThanOrEqualTo(0)) continue

      const sale = await tx.sale.findFirst({
        where: { id: allocation.saleId },
        select: { amountPaid: true, balanceDue: true, status: true },
      })
      if (!sale || sale.status !== 'COMPLETED') continue

      await tx.sale.update({
        where: { id: allocation.saleId },
        data: {
          amountPaid: toAmountString(m(sale.amountPaid).minus(allocation.amount)),
          balanceDue: toAmountString(m(sale.balanceDue).plus(allocation.amount)),
        },
      })
      restored = restored.plus(m(allocation.amount))
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'REVERSED',
        reversedAt: new Date(),
        reversedByUserId: ctx.userId,
        notes: reason,
      },
    })

    if (restored.greaterThan(0)) {
      await tx.customer.update({
        where: { id: payment.customerId },
        data: { balance: { increment: toAmountString(restored) } },
      })
    }

    await writeAudit(tx, ctx, {
      action: 'payment.reversed',
      entityType: 'Payment',
      entityId: payment.id,
      before: { amount: payment.amount.toString(), method: payment.method },
      after: { reason, restored: toAmountString(restored) },
    })
  })
}

export type ReceivablesRow = {
  customerId: string
  name: string
  accountNumber: string
  balance: string
  oldestDueDate: string | null
  invoiceCount: number
}

export async function getReceivables(ctx: AuthContext): Promise<{
  rows: ReceivablesRow[]
  total: string
}> {
  requirePermission(ctx, 'payment:read')
  const prisma = db(ctx)

  const open = await prisma.sale.findMany({
    where: { status: 'COMPLETED', balanceDue: { gt: 0 } },
    orderBy: [{ dueDate: 'asc' }],
    select: {
      customerId: true, balanceDue: true, dueDate: true, occurredAt: true,
      customer: { select: { name: true, accountNumber: true } },
    },
  })

  const byCustomer = new Map<string, ReceivablesRow>()
  for (const sale of open) {
    const existing = byCustomer.get(sale.customerId)
    const due = (sale.dueDate ?? sale.occurredAt).toISOString()

    if (existing) {
      existing.balance = toAmountString(m(existing.balance).plus(sale.balanceDue))
      existing.invoiceCount += 1
      if (!existing.oldestDueDate || due < existing.oldestDueDate) existing.oldestDueDate = due
    } else {
      byCustomer.set(sale.customerId, {
        customerId: sale.customerId,
        name: sale.customer.name,
        accountNumber: sale.customer.accountNumber,
        balance: toAmountString(sale.balanceDue),
        oldestDueDate: due,
        invoiceCount: 1,
      })
    }
  }

  const rows = [...byCustomer.values()].sort((a, b) => Number(b.balance) - Number(a.balance))
  return { rows, total: toAmountString(sum(rows.map((r) => r.balance))) }
}

function requiresAllocation(input: RecordPaymentInput): boolean {
  return (input.allocations ?? []).length === 0
}
