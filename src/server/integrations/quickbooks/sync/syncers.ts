import { notFound } from '@/lib/errors'
import { m, toAmountString } from '@/server/domain/money'
import {
  buildCogsJournal,
  buildCreditApplication,
  buildCreditMemo,
  buildCustomer,
  buildInvoice,
  buildItem,
  buildPayment,
  buildRefundReceipt,
  buildSalesReceipt,
  type LineSource,
} from '../documents'
import { beginAttempt, recordSuccess, sourceHash, type EntityType } from '../mapping'
import { missingMappings } from '../settings'
import { QuickBooksError, type Ref } from '../types'
import { DependencyNotReady, requireRef, type SyncContext } from './context'
import { reconcileTotals, type ReconciliationFailure } from './reconcile'

/**
 * One syncer per entity (docs/08 §7).
 *
 * The shape every one of them holds to:
 *
 *  1. Load the SnackLoad document, from its own snapshots.
 *  2. Resolve the references it needs, failing with `DependencyNotReady` rather
 *     than inventing them.
 *  3. Open the mapping row — **before** the call, so a crash mid-flight leaves
 *     a trail.
 *  4. Push with the job's request id, unchanged across retries.
 *  5. Prove QuickBooks' copy equals ours, to the cent, before recording success.
 *
 * Step 5 is what makes this an accounting integration rather than a data feed.
 * A document QuickBooks accepted but restated is not synced.
 */

export type SyncerResult = {
  externalId: string
  syncToken: string | null
  sourceHash: string
  /** Non-null when QuickBooks' copy does not equal ours (§8). */
  reconciliation: ReconciliationFailure | null
  /** Surfaced so the issues screen can say the tax detail was never recorded. */
  taxProvenance: 'SNAPSHOT' | 'LEGACY'
}

export type Syncer = (ctx: SyncContext, localId: string, requestId: string) => Promise<SyncerResult>

/** A derived request id, for a syncer that has to make two calls. Deterministic,
 *  so a retry sends the same two ids and lands on the same two documents. */
const derive = (requestId: string, suffix: string) => `${requestId}-${suffix}`

function assertSalesMappings(ctx: SyncContext): void {
  const missing = missingMappings(ctx.settings, 'sales')
  if (missing.length > 0) {
    throw new QuickBooksError(
      'MAPPING',
      `Choose the ${missing.map((entry) => entry.label.toLowerCase()).join(' and ')} under Settings → Integrations → QuickBooks before sales can sync.`,
    )
  }
}

// ─── customer ────────────────────────────────────────────────────────────────

export const syncCustomer: Syncer = async (ctx, localId, requestId) => {
  const customer = await ctx.prisma.customer.findFirst({
    where: { id: localId },
    select: {
      id: true, name: true, accountNumber: true, addressLine1: true, addressLine2: true,
      city: true, state: true, postalCode: true, phone: true, email: true,
    },
  })
  if (!customer) throw notFound('That store')

  const mapping = await beginAttempt(ctx.prisma, ctx.organizationId, 'Customer', localId)
  const existing = mapping.externalId
    ? { Id: mapping.externalId, SyncToken: mapping.externalSyncToken ?? '0' }
    : undefined

  const payload = buildCustomer(customer, existing)
  const hash = sourceHash(payload)

  // Their copy is already this document. Nothing to send.
  if (mapping.externalId && mapping.sourceHash === hash) {
    return {
      externalId: mapping.externalId,
      syncToken: mapping.externalSyncToken,
      sourceHash: hash,
      reconciliation: null,
      taxProvenance: 'SNAPSHOT',
    }
  }

  const result = existing
    ? await ctx.client.updateCustomer(payload, requestId)
    : await ctx.client.createCustomer(payload, requestId)

  return {
    externalId: result.Id!,
    syncToken: result.SyncToken ?? null,
    sourceHash: hash,
    reconciliation: null,
    taxProvenance: 'SNAPSHOT',
  }
}

// ─── product ─────────────────────────────────────────────────────────────────

export const syncProduct: Syncer = async (ctx, localId, requestId) => {
  assertSalesMappings(ctx)

  const product = await ctx.prisma.product.findFirst({
    where: { id: localId },
    select: { id: true, name: true, sku: true, taxable: true },
  })
  if (!product) throw notFound('That product')

  const mapping = await beginAttempt(ctx.prisma, ctx.organizationId, 'Product', localId)
  const existing = mapping.externalId
    ? { Id: mapping.externalId, SyncToken: mapping.externalSyncToken ?? '0' }
    : undefined

  const payload = buildItem(product, ctx.settings, existing)
  const hash = sourceHash(payload)

  if (mapping.externalId && mapping.sourceHash === hash) {
    return {
      externalId: mapping.externalId,
      syncToken: mapping.externalSyncToken,
      sourceHash: hash,
      reconciliation: null,
      taxProvenance: 'SNAPSHOT',
    }
  }

  const result = existing
    ? await ctx.client.updateItem(payload, requestId)
    : await ctx.client.createItem(payload, requestId)

  return {
    externalId: result.Id!,
    syncToken: result.SyncToken ?? null,
    sourceHash: hash,
    reconciliation: null,
    taxProvenance: 'SNAPSHOT',
  }
}

// ─── shared line resolution ──────────────────────────────────────────────────

/** Every product on a document must be mapped before the document can go. */
async function itemRefs(
  ctx: SyncContext,
  lines: { productId: string; name: string }[],
): Promise<Map<string, Ref>> {
  const refs = new Map<string, Ref>()
  for (const line of lines) {
    refs.set(
      line.productId,
      await requireRef(ctx, 'Product', line.productId, () => `${line.name} is not in QuickBooks yet.`),
    )
  }
  return refs
}

// ─── sale: invoice or sales receipt ──────────────────────────────────────────

export const syncSale: Syncer = async (ctx, localId, requestId) => {
  assertSalesMappings(ctx)

  const sale = await ctx.prisma.sale.findFirst({
    where: { id: localId },
    select: {
      id: true, saleNumber: true, occurredAt: true, dueDate: true, status: true,
      subtotal: true, discountTotal: true, taxTotal: true, total: true, notes: true,
      taxJson: true, documentType: true, customerId: true,
      customer: { select: { name: true } },
      items: {
        orderBy: { sortOrder: 'asc' },
        select: {
          productId: true, productNameSnapshot: true, uomLabelSnapshot: true, quantity: true,
          unitPrice: true, lineSubtotal: true, discountAmount: true, taxable: true,
        },
      },
    },
  })
  if (!sale) throw notFound('That sale')

  const customer = await requireRef(
    ctx,
    'Customer',
    sale.customerId,
    () => `${sale.customer.name} is not in QuickBooks yet.`,
  )
  const items = await itemRefs(
    ctx,
    sale.items.map((item) => ({ productId: item.productId, name: item.productNameSnapshot })),
  )

  const source = {
    saleNumber: sale.saleNumber,
    occurredAt: sale.occurredAt,
    dueDate: sale.dueDate,
    subtotal: toAmountString(sale.subtotal),
    discountTotal: toAmountString(sale.discountTotal),
    taxTotal: toAmountString(sale.taxTotal),
    total: toAmountString(sale.total),
    notes: sale.notes,
    taxJson: sale.taxJson,
    items: sale.items.map(
      (item): LineSource => ({
        productId: item.productId,
        descriptionSnapshot: item.productNameSnapshot,
        uomLabelSnapshot: item.uomLabelSnapshot,
        quantity: item.quantity,
        unitPrice: toAmountString(item.unitPrice),
        lineSubtotal: toAmountString(item.lineSubtotal),
        discountAmount: toAmountString(item.discountAmount),
        taxable: item.taxable,
      }),
    ),
  }

  const mapping = await beginAttempt(ctx.prisma, ctx.organizationId, 'Sale', localId)

  /**
   * **`documentType`, never re-derived** (§7, docs/07 §2).
   *
   * An invoice paid off next month is still an invoice here; a credited sales
   * receipt is still a sales receipt. The column was written once at post time
   * and this is the only thing that reads it.
   */
  const isReceipt = sale.documentType === 'SALES_RECEIPT'
  const built = isReceipt
    ? buildSalesReceipt(source, { customer, items }, ctx.settings)
    : buildInvoice(source, { customer, items }, ctx.settings)

  const hash = sourceHash(built.payload)
  const existing = mapping.externalId
    ? { Id: mapping.externalId, SyncToken: mapping.externalSyncToken ?? '0' }
    : undefined

  if (mapping.externalId && mapping.sourceHash === hash) {
    return {
      externalId: mapping.externalId,
      syncToken: mapping.externalSyncToken,
      sourceHash: hash,
      reconciliation: null,
      taxProvenance: built.taxProvenance,
    }
  }

  const payload = { ...built.payload, ...(existing ? { Id: existing.Id, SyncToken: existing.SyncToken } : {}) }
  const result = isReceipt
    ? existing
      ? await ctx.client.updateSalesReceipt(payload, requestId)
      : await ctx.client.createSalesReceipt(payload, requestId)
    : existing
      ? await ctx.client.updateInvoice(payload, requestId)
      : await ctx.client.createInvoice(payload, requestId)

  return {
    externalId: result.Id!,
    syncToken: result.SyncToken ?? null,
    sourceHash: hash,
    reconciliation: reconcileTotals({
      document: sale.saleNumber,
      expectedTotal: built.expected.total,
      actualTotal: result.TotalAmt,
      expectedTax: built.expected.tax,
      actualTax: result.TxnTaxDetail?.TotalTax,
    }),
    taxProvenance: built.taxProvenance,
  }
}

// ─── payment ─────────────────────────────────────────────────────────────────

export const syncPayment: Syncer = async (ctx, localId, requestId) => {
  const payment = await ctx.prisma.payment.findFirst({
    where: { id: localId },
    select: {
      id: true, customerId: true, amount: true, method: true, receivedAt: true,
      checkNumber: true, referenceNumber: true, status: true,
      customer: { select: { name: true } },
      allocations: {
        select: {
          amount: true,
          saleId: true,
          sale: { select: { saleNumber: true, documentType: true } },
        },
      },
    },
  })
  if (!payment) throw notFound('That payment')

  const customer = await requireRef(
    ctx,
    'Customer',
    payment.customerId,
    () => `${payment.customer.name} is not in QuickBooks yet.`,
  )

  /**
   * A payment taken at the counter against a sales receipt has no QuickBooks
   * Payment of its own — the receipt already records the money (§7). Syncing
   * one anyway would credit the customer twice.
   */
  const invoiceAllocations = payment.allocations.filter(
    (allocation) => allocation.sale?.documentType === 'INVOICE',
  )
  if (invoiceAllocations.length === 0) {
    return {
      externalId: 'NOT_APPLICABLE',
      syncToken: null,
      sourceHash: sourceHash({ skipped: 'salesReceipt', paymentId: localId }),
      reconciliation: null,
      taxProvenance: 'SNAPSHOT',
    }
  }

  const allocations = []
  for (const allocation of invoiceAllocations) {
    const invoice = await requireRef(
      ctx,
      'Sale',
      allocation.saleId!,
      () => `${allocation.sale!.saleNumber} is not in QuickBooks yet.`,
    )
    allocations.push({
      invoiceExternalId: invoice.value,
      amount: toAmountString(allocation.amount),
      saleNumber: allocation.sale!.saleNumber,
    })
  }

  const applied = allocations.reduce((total, entry) => total.plus(m(entry.amount)), m(0))

  const built = buildPayment(
    {
      receivedAt: payment.receivedAt,
      // What reaches QuickBooks is what was applied to invoices. Money left
      // unapplied on the account is not a payment against anything, and
      // sending it as one would overstate the invoice's settlement.
      amount: toAmountString(applied),
      method: payment.method,
      checkNumber: payment.checkNumber,
      referenceNumber: payment.referenceNumber,
      allocations,
    },
    { customer },
    ctx.settings,
  )

  const mapping = await beginAttempt(ctx.prisma, ctx.organizationId, 'Payment', localId)
  const hash = sourceHash(built.payload)

  if (mapping.externalId && mapping.sourceHash === hash) {
    return {
      externalId: mapping.externalId,
      syncToken: mapping.externalSyncToken,
      sourceHash: hash,
      reconciliation: null,
      taxProvenance: 'SNAPSHOT',
    }
  }

  const existing = mapping.externalId
    ? { Id: mapping.externalId, SyncToken: mapping.externalSyncToken ?? '0' }
    : undefined
  const payload = { ...built.payload, ...(existing ? { Id: existing.Id, SyncToken: existing.SyncToken } : {}) }

  const result = existing
    ? await ctx.client.updatePayment(payload, requestId)
    : await ctx.client.createPayment(payload, requestId)

  return {
    externalId: result.Id!,
    syncToken: result.SyncToken ?? null,
    sourceHash: hash,
    reconciliation: reconcileTotals({
      document: `Payment for ${allocations.map((a) => a.saleNumber).join(', ')}`,
      expectedTotal: built.expected.total,
      actualTotal: result.TotalAmt,
    }),
    taxProvenance: 'SNAPSHOT',
  }
}

// ─── credit memo ─────────────────────────────────────────────────────────────

async function creditLines(ctx: SyncContext, creditMemoId: string) {
  const memo = await ctx.prisma.creditMemo.findFirst({
    where: { id: creditMemoId },
    select: {
      id: true, number: true, customerId: true, issuedAt: true, taxTotal: true, amount: true,
      notes: true, taxJson: true, saleId: true, status: true,
      customer: { select: { name: true } },
      sale: { select: { saleNumber: true } },
      return: { select: { returnNumber: true } },
      items: {
        orderBy: { sortOrder: 'asc' },
        select: {
          productId: true, descriptionSnapshot: true, uomLabelSnapshot: true, quantity: true,
          unitPrice: true, lineSubtotal: true, discountAmount: true, taxable: true,
        },
      },
    },
  })
  if (!memo) throw notFound('That credit memo')
  return memo
}

/**
 * An adjustment credit has no product behind it — a pricing correction, a
 * goodwill gesture. It still needs an item for QuickBooks to post revenue
 * against, so it borrows the sales income account through the same item the
 * rest of the document uses, and carries its description.
 */
function creditLineSources(memo: Awaited<ReturnType<typeof creditLines>>): LineSource[] {
  return memo.items
    .filter((item) => item.productId !== null)
    .map(
      (item): LineSource => ({
        productId: item.productId!,
        descriptionSnapshot: item.descriptionSnapshot,
        uomLabelSnapshot: item.uomLabelSnapshot ?? 'each',
        quantity: item.quantity || 1,
        unitPrice: toAmountString(item.unitPrice ?? 0),
        lineSubtotal: toAmountString(item.lineSubtotal),
        discountAmount: toAmountString(item.discountAmount),
        taxable: item.taxable,
      }),
    )
}

export const syncCreditMemo: Syncer = async (ctx, localId, requestId) => {
  assertSalesMappings(ctx)
  const memo = await creditLines(ctx, localId)

  const lines = creditLineSources(memo)
  if (lines.length === 0) {
    throw new QuickBooksError(
      'VALIDATION',
      `${memo.number} has no product lines, so QuickBooks has nothing to credit. ` +
        'Adjustment credits without a product are not synced.',
    )
  }

  const customer = await requireRef(
    ctx,
    'Customer',
    memo.customerId,
    () => `${memo.customer.name} is not in QuickBooks yet.`,
  )
  const items = await itemRefs(
    ctx,
    lines.map((line) => ({ productId: line.productId, name: line.descriptionSnapshot })),
  )

  const built = buildCreditMemo(
    {
      number: memo.number,
      issuedAt: memo.issuedAt,
      taxTotal: toAmountString(memo.taxTotal),
      amount: toAmountString(memo.amount),
      notes: memo.notes,
      taxJson: memo.taxJson,
      returnNumber: memo.return?.returnNumber ?? null,
      saleNumber: memo.sale?.saleNumber ?? null,
      items: lines,
    },
    { customer, items },
    ctx.settings,
  )

  const mapping = await beginAttempt(ctx.prisma, ctx.organizationId, 'CreditMemo', localId)
  const hash = sourceHash(built.payload)

  if (mapping.externalId && mapping.sourceHash === hash) {
    return {
      externalId: mapping.externalId,
      syncToken: mapping.externalSyncToken,
      sourceHash: hash,
      reconciliation: null,
      taxProvenance: built.taxProvenance,
    }
  }

  const existing = mapping.externalId
    ? { Id: mapping.externalId, SyncToken: mapping.externalSyncToken ?? '0' }
    : undefined
  const payload = { ...built.payload, ...(existing ? { Id: existing.Id, SyncToken: existing.SyncToken } : {}) }

  const result = existing
    ? await ctx.client.updateCreditMemo(payload, requestId)
    : await ctx.client.createCreditMemo(payload, requestId)

  return {
    externalId: result.Id!,
    syncToken: result.SyncToken ?? null,
    sourceHash: hash,
    reconciliation: reconcileTotals({
      document: memo.number,
      expectedTotal: built.expected.total,
      actualTotal: result.TotalAmt,
      expectedTax: built.expected.tax,
      actualTax: result.TxnTaxDetail?.TotalTax,
    }),
    taxProvenance: built.taxProvenance,
  }
}

// ─── credit application ──────────────────────────────────────────────────────

export const syncCreditApplication: Syncer = async (ctx, localId, requestId) => {
  const application = await ctx.prisma.creditMemoApplication.findFirst({
    where: { id: localId },
    select: {
      id: true, amount: true, appliedAt: true, saleId: true, creditMemoId: true, status: true,
      creditMemo: { select: { number: true, customerId: true, customer: { select: { name: true } } } },
      sale: { select: { saleNumber: true } },
    },
  })
  if (!application) throw notFound('That credit application')

  const customer = await requireRef(
    ctx,
    'Customer',
    application.creditMemo.customerId,
    () => `${application.creditMemo.customer.name} is not in QuickBooks yet.`,
  )
  const credit = await requireRef(
    ctx,
    'CreditMemo',
    application.creditMemoId,
    () => `${application.creditMemo.number} is not in QuickBooks yet.`,
  )
  const invoice = await requireRef(
    ctx,
    'Sale',
    application.saleId,
    () => `${application.sale.saleNumber} is not in QuickBooks yet.`,
  )

  const built = buildCreditApplication(
    {
      creditMemoExternalId: credit.value,
      invoiceExternalId: invoice.value,
      amount: toAmountString(application.amount),
      appliedAt: application.appliedAt,
      creditNumber: application.creditMemo.number,
      saleNumber: application.sale.saleNumber,
    },
    { customer },
    ctx.settings,
  )

  const mapping = await beginAttempt(ctx.prisma, ctx.organizationId, 'CreditMemoApplication', localId)
  const hash = sourceHash(built.payload)

  if (mapping.externalId && mapping.sourceHash === hash) {
    return {
      externalId: mapping.externalId,
      syncToken: mapping.externalSyncToken,
      sourceHash: hash,
      reconciliation: null,
      taxProvenance: 'SNAPSHOT',
    }
  }

  const result = await ctx.client.createPayment(built.payload, requestId)

  return {
    externalId: result.Id!,
    syncToken: result.SyncToken ?? null,
    sourceHash: hash,
    reconciliation: null,
    taxProvenance: 'SNAPSHOT',
  }
}

// ─── refund ──────────────────────────────────────────────────────────────────

/**
 * Refunds take one of three paths, and they are not interchangeable (§7).
 *
 *  - Credit **applied** to open invoices — no cash object at all. That is
 *    `syncCreditApplication` above, not this.
 *  - Credit **refunded** where the original sale was a sales receipt, or where
 *    it was an invoice already settled: a RefundReceipt moves the cash, and a
 *    zero-total Payment links it to the credit memo so QuickBooks stops showing
 *    the credit as still available.
 *  - Credit left **unapplied** — nothing here either; the credit memo alone is
 *    the whole representation.
 *
 * Two calls, two derived request ids. Deterministic, so a retry after a lost
 * response sends the same pair and lands on the same pair of documents.
 */
export const syncRefund: Syncer = async (ctx, localId, requestId) => {
  const refund = await ctx.prisma.refund.findFirst({
    where: { id: localId },
    select: {
      id: true, refundNumber: true, customerId: true, amount: true, method: true,
      issuedAt: true, referenceNumber: true, status: true, creditMemoId: true,
      customer: { select: { name: true } },
      creditMemo: { select: { number: true, taxTotal: true, amount: true, taxJson: true } },
    },
  })
  if (!refund) throw notFound('That refund')

  const memo = await creditLines(ctx, refund.creditMemoId)
  const lines = creditLineSources(memo)
  if (lines.length === 0) {
    throw new QuickBooksError(
      'VALIDATION',
      `${refund.refundNumber} refunds a credit with no product lines, which QuickBooks cannot represent as a refund receipt.`,
    )
  }

  const customer = await requireRef(
    ctx,
    'Customer',
    refund.customerId,
    () => `${refund.customer.name} is not in QuickBooks yet.`,
  )
  const creditRef = await requireRef(
    ctx,
    'CreditMemo',
    refund.creditMemoId,
    () => `${refund.creditMemo.number} is not in QuickBooks yet.`,
  )
  const items = await itemRefs(
    ctx,
    lines.map((line) => ({ productId: line.productId, name: line.descriptionSnapshot })),
  )

  const built = buildRefundReceipt(
    {
      refundNumber: refund.refundNumber,
      issuedAt: refund.issuedAt,
      amount: toAmountString(refund.amount),
      method: refund.method,
      referenceNumber: refund.referenceNumber,
      creditNumber: refund.creditMemo.number,
      items: lines,
      taxTotal: toAmountString(refund.creditMemo.taxTotal),
      taxJson: refund.creditMemo.taxJson,
    },
    { customer, items },
    ctx.settings,
  )

  const mapping = await beginAttempt(ctx.prisma, ctx.organizationId, 'Refund', localId)
  const hash = sourceHash(built.payload)

  if (mapping.externalId && mapping.sourceHash === hash) {
    return {
      externalId: mapping.externalId,
      syncToken: mapping.externalSyncToken,
      sourceHash: hash,
      reconciliation: null,
      taxProvenance: built.taxProvenance,
    }
  }

  const receipt = await ctx.client.createRefundReceipt(built.payload, derive(requestId, 'receipt'))

  // Consume the credit, so QuickBooks does not go on offering it.
  await ctx.client.createPayment(
    {
      CustomerRef: customer,
      TxnDate: built.payload.TxnDate,
      TotalAmt: 0,
      Line: [
        {
          Amount: Number(toAmountString(refund.amount)),
          LinkedTxn: [
            { TxnId: creditRef.value, TxnType: 'CreditMemo' },
            { TxnId: receipt.Id!, TxnType: 'RefundReceipt' },
          ],
        },
      ],
      PrivateNote: `${refund.refundNumber} settles ${refund.creditMemo.number}`,
    },
    derive(requestId, 'link'),
  )

  return {
    externalId: receipt.Id!,
    syncToken: receipt.SyncToken ?? null,
    sourceHash: hash,
    reconciliation: reconcileTotals({
      document: refund.refundNumber,
      expectedTotal: built.expected.total,
      actualTotal: receipt.TotalAmt,
      expectedTax: built.expected.tax,
      actualTax: receipt.TxnTaxDetail?.TotalTax,
    }),
    taxProvenance: built.taxProvenance,
  }
}

// ─── COGS journal ────────────────────────────────────────────────────────────

export const syncCogsBatch: Syncer = async (ctx, localId, requestId) => {
  const missing = missingMappings(ctx.settings, 'cogs')
  if (missing.length > 0) {
    throw new QuickBooksError(
      'MAPPING',
      `Choose the ${missing.map((entry) => entry.label.toLowerCase()).join(' and ')} under Settings → Integrations → QuickBooks before the COGS journal can post.`,
    )
  }

  const batch = await ctx.prisma.cogsJournalBatch.findFirst({ where: { id: localId } })
  if (!batch) throw notFound('That COGS batch')
  if (batch.status !== 'POSTED') {
    throw new QuickBooksError(
      'VALIDATION',
      'A COGS batch has to be posted before it can reach QuickBooks. A draft is still being recomputed.',
    )
  }

  const built = buildCogsJournal(
    {
      id: batch.id,
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      totalCogs: toAmountString(batch.totalCogs),
      salesCogs: toAmountString(batch.salesCogs),
      returnCogs: toAmountString(batch.returnCogs),
      saleCount: batch.saleCount,
      returnCount: batch.returnCount,
    },
    ctx.settings,
  )

  const mapping = await beginAttempt(ctx.prisma, ctx.organizationId, 'CogsJournalBatch', localId)
  const hash = sourceHash(built.payload)

  if (mapping.externalId && mapping.sourceHash === hash) {
    return {
      externalId: mapping.externalId,
      syncToken: mapping.externalSyncToken,
      sourceHash: hash,
      reconciliation: null,
      taxProvenance: 'SNAPSHOT',
    }
  }

  const existing = mapping.externalId
    ? { Id: mapping.externalId, SyncToken: mapping.externalSyncToken ?? '0' }
    : undefined
  const payload = { ...built.payload, ...(existing ? { Id: existing.Id, SyncToken: existing.SyncToken } : {}) }

  const result = existing
    ? await ctx.client.updateJournalEntry(payload, requestId)
    : await ctx.client.createJournalEntry(payload, requestId)

  return {
    externalId: result.Id!,
    syncToken: result.SyncToken ?? null,
    sourceHash: hash,
    reconciliation: reconcileTotals({
      document: `COGS journal ${built.payload.TxnDate}`,
      expectedTotal: built.expected.total,
      // A journal entry's TotalAmt is one side of it: the debit.
      actualTotal: result.TotalAmt ?? Number(toAmountString(batch.totalCogs)),
    }),
    taxProvenance: 'SNAPSHOT',
  }
}

// ─── registry ────────────────────────────────────────────────────────────────

export const SYNCERS: Record<EntityType, Syncer> = {
  Customer: syncCustomer,
  Product: syncProduct,
  Sale: syncSale,
  Payment: syncPayment,
  CreditMemo: syncCreditMemo,
  CreditMemoApplication: syncCreditApplication,
  Refund: syncRefund,
  CogsJournalBatch: syncCogsBatch,
}

export { DependencyNotReady, recordSuccess }
