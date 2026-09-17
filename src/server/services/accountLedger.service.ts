import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { notFound } from '@/lib/errors'
import { toAmountString } from '@/server/domain/money'
import { getCreditPosition, type CreditPosition } from './credit.service'

/**
 * One store's whole financial history, in order (spec §11).
 *
 * Invoices, payments, returns, credit memos and refunds on a single timeline,
 * because "why does this store owe what it owes" is one question and answering
 * it by sending somebody to four different screens is how disputes turn into
 * afternoons. Each entry links to the document it came from.
 *
 * Nothing here is computed: every row is a document that exists, with the
 * figure that document carries.
 */

export type LedgerEntryKind = 'INVOICE' | 'PAYMENT' | 'RETURN' | 'CREDIT' | 'REFUND'

export type LedgerEntry = {
  id: string
  kind: LedgerEntryKind
  occurredAt: string
  /** Document number, as printed. */
  reference: string
  description: string
  /** Signed from the STORE's point of view: positive increases what they owe. */
  amount: string
  /** Where to read the document itself. */
  href: string | null
  voided: boolean
  actorName: string | null
  /** A short status word, where the document has one worth showing. */
  status: string | null
}

export async function getAccountLedger(
  ctx: AuthContext,
  customerId: string,
  options: { limit?: number } = {},
): Promise<{
  customer: { id: string; name: string; accountNumber: string }
  position: CreditPosition
  entries: LedgerEntry[]
}> {
  requirePermission(ctx, 'customer:read')
  const prisma = db(ctx)
  const take = Math.min(400, Math.max(10, options.limit ?? 200))

  const customer = await prisma.customer.findFirst({
    where: { id: customerId },
    select: { id: true, name: true, accountNumber: true },
  })
  if (!customer) throw notFound('That store')

  const [sales, payments, returns, memos, refunds, position] = await Promise.all([
    prisma.sale.findMany({
      where: { customerId },
      orderBy: { occurredAt: 'desc' },
      take,
      select: {
        id: true, saleNumber: true, occurredAt: true, status: true, total: true,
        balanceDue: true,
        soldBy: { select: { firstName: true, lastName: true } },
        receipt: { select: { receiptNumber: true } },
      },
    }),
    prisma.payment.findMany({
      where: { customerId },
      orderBy: { receivedAt: 'desc' },
      take,
      select: {
        id: true, receivedAt: true, amount: true, method: true, status: true,
        unappliedAmount: true, checkNumber: true, referenceNumber: true,
        receivedBy: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.return.findMany({
      where: { customerId },
      orderBy: { occurredAt: 'desc' },
      take,
      select: {
        id: true, returnNumber: true, occurredAt: true, status: true, total: true,
        reason: true, creditMemoId: true, saleId: true,
        createdBy: { select: { firstName: true, lastName: true } },
        sale: { select: { saleNumber: true } },
      },
    }),
    prisma.creditMemo.findMany({
      where: { customerId },
      orderBy: { issuedAt: 'desc' },
      take,
      select: {
        id: true, number: true, issuedAt: true, status: true, amount: true,
        remainingAmount: true, refundedAmount: true,
        issuedBy: { select: { firstName: true, lastName: true } },
        return: { select: { returnNumber: true } },
      },
    }),
    prisma.refund.findMany({
      where: { customerId },
      orderBy: { issuedAt: 'desc' },
      take,
      select: {
        id: true, refundNumber: true, issuedAt: true, amount: true, method: true,
        status: true, referenceNumber: true, creditMemoId: true,
        issuedBy: { select: { firstName: true, lastName: true } },
      },
    }),
    getCreditPosition(ctx, customerId),
  ])

  const entries: LedgerEntry[] = [
    ...sales.map((sale): LedgerEntry => ({
      id: `sale:${sale.id}`,
      kind: 'INVOICE',
      occurredAt: sale.occurredAt.toISOString(),
      reference: sale.receipt?.receiptNumber ?? sale.saleNumber,
      description: sale.status === 'VOIDED' ? 'Invoice (voided)' : 'Invoice',
      // An invoice increases what the store owes.
      amount: sale.status === 'VOIDED' ? '0.00' : toAmountString(sale.total),
      href: `/receipts/${sale.id}`,
      voided: sale.status === 'VOIDED',
      actorName: name(sale.soldBy),
      status:
        sale.status === 'VOIDED'
          ? 'Voided'
          : Number(sale.balanceDue) > 0
            ? `${toAmountString(sale.balanceDue)} open`
            : 'Paid',
    })),

    ...payments.map((payment): LedgerEntry => ({
      id: `payment:${payment.id}`,
      kind: 'PAYMENT',
      occurredAt: payment.receivedAt.toISOString(),
      reference: payment.checkNumber ?? payment.referenceNumber ?? payment.method,
      description: `Payment · ${payment.method.toLowerCase()}`,
      amount:
        payment.status === 'REVERSED'
          ? '0.00'
          : `-${toAmountString(payment.amount)}`,
      href: null,
      voided: payment.status === 'REVERSED',
      actorName: name(payment.receivedBy),
      status:
        payment.status === 'REVERSED'
          ? 'Reversed'
          : Number(payment.unappliedAmount) > 0
            ? `${toAmountString(payment.unappliedAmount)} on account`
            : null,
    })),

    ...returns.map((row): LedgerEntry => ({
      id: `return:${row.id}`,
      kind: 'RETURN',
      occurredAt: row.occurredAt.toISOString(),
      reference: row.returnNumber,
      description: row.sale
        ? `Return against ${row.sale.saleNumber} · ${row.reason.toLowerCase().replace(/_/g, ' ')}`
        : `Return · ${row.reason.toLowerCase().replace(/_/g, ' ')}`,
      // The return itself moves goods; the money moves on its credit memo, so
      // counting it here as well would double-count.
      amount: '0.00',
      href: row.creditMemoId ? `/credits/${row.creditMemoId}` : `/receipts/${row.saleId ?? ''}`,
      voided: row.status === 'VOIDED',
      actorName: name(row.createdBy),
      status: row.status === 'VOIDED' ? 'Voided' : 'Goods received',
    })),

    ...memos.map((memo): LedgerEntry => ({
      id: `credit:${memo.id}`,
      kind: 'CREDIT',
      occurredAt: memo.issuedAt.toISOString(),
      reference: memo.number,
      description: memo.return
        ? `Credit memo from ${memo.return.returnNumber}`
        : 'Credit memo',
      amount: memo.status === 'VOIDED' ? '0.00' : `-${toAmountString(memo.amount)}`,
      href: `/credits/${memo.id}`,
      voided: memo.status === 'VOIDED',
      actorName: name(memo.issuedBy),
      status:
        memo.status === 'VOIDED'
          ? 'Voided'
          : Number(memo.remainingAmount) > 0
            ? `${toAmountString(memo.remainingAmount)} available`
            : Number(memo.refundedAmount) > 0
              ? 'Refunded'
              : 'Applied',
    })),

    ...refunds.map((refund): LedgerEntry => ({
      id: `refund:${refund.id}`,
      kind: 'REFUND',
      occurredAt: refund.issuedAt.toISOString(),
      reference: refund.refundNumber,
      description: `Refund · ${refund.method.toLowerCase()}${refund.referenceNumber ? ` #${refund.referenceNumber}` : ''}`,
      // Cash going back to the store spends credit rather than changing AR, so
      // it is shown at zero effect on the balance and non-zero on the page.
      amount: '0.00',
      href: `/credits/${refund.creditMemoId}`,
      voided: refund.status === 'VOIDED',
      actorName: name(refund.issuedBy),
      status:
        refund.status === 'VOIDED'
          ? 'Voided'
          : `${toAmountString(refund.amount)} paid out`,
    })),
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))

  return { customer, position, entries: entries.slice(0, take) }
}

function name(person: { firstName: string; lastName: string } | null): string | null {
  return person ? `${person.firstName} ${person.lastName}`.trim() : null
}
