import { notFound } from '@/lib/errors'
import { m, toAmountString } from '@/server/domain/money'
import {
  buildCogsJournal,
  buildReversingJournal,
  buildVoidedCreditMemo,
  buildVoidedRefundReceipt,
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
import {
  beginAttempt,
  externalIdFor,
  findMapping,
  recordSuccess,
  sourceHash,
  type EntityType,
} from '../mapping'
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

/**
 * A create or update never sends a document that has been reversed locally
 * (docs/08 §17). Two things depend on this:
 *
 *  - It closes the only race between creating and reversing. A sale posted and
 *    voided before the worker reached it would otherwise be created — and then
 *    need voiding — because the create job was queued first. Refusing here
 *    means the void job finds nothing to reverse, which is the truth.
 *  - It stops a re-sync pushing a live payload over a document that is voided.
 *    Reversing it is the void job's business, and only the void job's.
 */
const SKIPPED_AS_VOIDED: SyncerResult = {
  externalId: 'NOT_APPLICABLE',
  syncToken: null,
  sourceHash: 'reversed-locally',
  reconciliation: null,
  taxProvenance: 'SNAPSHOT',
}

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
  if (sale.status === 'VOIDED') return SKIPPED_AS_VOIDED

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

/**
 * A payment, and the arithmetic that explains it (docs/08 §18).
 *
 * One SnackLoad collection does not always become one QuickBooks number, and
 * until this was written down it looked like a discrepancy. Every slice of the
 * payment gets a row saying where it lives:
 *
 *  - money against an **invoice** becomes a line on the QuickBooks Payment;
 *  - money taken at the counter against a **sales receipt** is already banked by
 *    that receipt — sending it again would be a second cash row for money that
 *    moved once;
 *  - money **not allocated** to anything rides on the QuickBooks Payment with no
 *    link, which is how QuickBooks holds credit on a customer's account.
 *
 * The three always add up to the SnackLoad total, and that is asserted before
 * anything is sent rather than hoped for afterwards.
 */
export const syncPayment: Syncer = async (ctx, localId, requestId) => {
  const payment = await ctx.prisma.payment.findFirst({
    where: { id: localId },
    select: {
      id: true, customerId: true, amount: true, method: true, receivedAt: true,
      checkNumber: true, referenceNumber: true, status: true, unappliedAmount: true,
      customer: { select: { name: true } },
      allocations: {
        select: {
          amount: true,
          saleId: true,
          sale: { select: { saleNumber: true, documentType: true, status: true } },
        },
      },
    },
  })
  if (!payment) throw notFound('That payment')
  if (payment.status !== 'POSTED') return SKIPPED_AS_VOIDED

  const customer = await requireRef(
    ctx,
    'Customer',
    payment.customerId,
    () => `${payment.customer.name} is not in QuickBooks yet.`,
  )

  const components: PaymentComponent[] = []
  const allocations: {
    invoiceExternalId: string
    amount: string
    saleNumber: string
    saleId: string
  }[] = []

  for (const allocation of payment.allocations) {
    const amount = m(allocation.amount)
    // A voided sale zeroes its allocation and the money moves to unapplied;
    // there is nothing left here to represent.
    if (!amount.greaterThan(0) || !allocation.sale || !allocation.saleId) continue

    if (allocation.sale.documentType === 'SALES_RECEIPT') {
      const receipt = await externalIdFor(ctx.prisma, 'Sale', allocation.saleId)
      components.push({
        saleId: allocation.saleId,
        amount: toAmountString(amount),
        representation: 'SALES_RECEIPT',
        externalId: receipt,
        explanation:
          `${toAmountString(amount)} was taken at the counter against ${allocation.sale.saleNumber}, ` +
          'which posted as a sales receipt and already records the money in QuickBooks. ' +
          'No separate QuickBooks payment is created for it.',
      })
      continue
    }

    const invoice = await requireRef(
      ctx,
      'Sale',
      allocation.saleId,
      () => `${allocation.sale!.saleNumber} is not in QuickBooks yet.`,
    )
    allocations.push({
      invoiceExternalId: invoice.value,
      amount: toAmountString(amount),
      saleNumber: allocation.sale.saleNumber,
      saleId: allocation.saleId,
    })
    components.push({
      saleId: allocation.saleId,
      amount: toAmountString(amount),
      representation: 'INVOICE_PAYMENT',
      externalId: null,
      explanation: `${toAmountString(amount)} settles ${allocation.sale.saleNumber}, as a line on the QuickBooks payment.`,
    })
  }

  const unapplied = m(payment.unappliedAmount)
  if (unapplied.greaterThan(0)) {
    components.push({
      saleId: null,
      amount: toAmountString(unapplied),
      representation: 'UNAPPLIED',
      externalId: null,
      explanation:
        `${toAmountString(unapplied)} was not applied to any invoice. It rides on the QuickBooks ` +
        'payment with no link, which is how QuickBooks holds credit on a customer account.',
    })
  }

  assertComponentsBalance(payment.amount.toString(), components)

  /**
   * Nothing for QuickBooks to hold: every penny is already recorded by the
   * sales receipts it was taken against. Creating a payment as well would
   * double the cash.
   */
  const sendable = components.filter((component) => component.representation !== 'SALES_RECEIPT')
  if (sendable.length === 0) {
    await writeComponents(ctx, payment.id, components)
    return {
      externalId: 'NOT_APPLICABLE',
      syncToken: null,
      sourceHash: sourceHash({ skipped: 'salesReceiptOnly', components }),
      reconciliation: null,
      taxProvenance: 'SNAPSHOT',
    }
  }

  const total = sendable.reduce((sum, component) => sum.plus(m(component.amount)), m(0))

  const built = buildPayment(
    {
      receivedAt: payment.receivedAt,
      amount: toAmountString(total),
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
    await writeComponents(ctx, payment.id, components, mapping.externalId)
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

  await writeComponents(ctx, payment.id, components, result.Id ?? null)

  return {
    externalId: result.Id!,
    syncToken: result.SyncToken ?? null,
    sourceHash: hash,
    reconciliation: reconcileTotals({
      // The expected total is what QuickBooks is meant to hold, not the whole
      // SnackLoad collection — the difference is the sales-receipt slice, and
      // the components above are what say so.
      document: `Payment from ${payment.customer.name}`,
      expectedTotal: built.expected.total,
      actualTotal: result.TotalAmt,
    }),
    taxProvenance: 'SNAPSHOT',
  }
}

type PaymentComponent = {
  saleId: string | null
  amount: string
  representation: 'INVOICE_PAYMENT' | 'SALES_RECEIPT' | 'UNAPPLIED'
  externalId: string | null
  explanation: string
}

/**
 * The invariant the whole model rests on: the slices are the payment.
 *
 * A failure here is a bug in this file, not a QuickBooks problem, so it is
 * raised before anything is sent rather than discovered as a mismatch after.
 */
function assertComponentsBalance(paymentAmount: string, components: PaymentComponent[]): void {
  const accounted = components.reduce((sum, component) => sum.plus(m(component.amount)), m(0))
  if (!m(paymentAmount).equals(accounted)) {
    throw new QuickBooksError(
      'VALIDATION',
      `This payment does not add up: ${toAmountString(m(paymentAmount))} collected, ` +
        `${toAmountString(accounted)} accounted for across invoices, sales receipts and unapplied credit.`,
    )
  }
}

/** Rebuilt every sync, so the projection cannot drift from what was sent. */
async function writeComponents(
  ctx: SyncContext,
  paymentId: string,
  components: PaymentComponent[],
  paymentExternalId?: string | null,
): Promise<void> {
  await ctx.prisma.$transaction(async (tx) => {
    await tx.paymentSyncAllocation.deleteMany({ where: { paymentId } })
    for (const component of components) {
      await tx.paymentSyncAllocation.create({
        data: {
          organizationId: ctx.organizationId,
          paymentId,
          saleId: component.saleId,
          amount: component.amount,
          representation: component.representation,
          externalId:
            component.representation === 'SALES_RECEIPT'
              ? component.externalId
              : (paymentExternalId ?? null),
          explanation: component.explanation,
        },
      })
    }
  })
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
  if (memo.status === 'VOIDED') return SKIPPED_AS_VOIDED

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
  if (application.status !== 'APPLIED') return SKIPPED_AS_VOIDED

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
  if (refund.status !== 'POSTED') return SKIPPED_AS_VOIDED

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

// ─── voids and reversals ─────────────────────────────────────────────────────

/**
 * Reversing a document that QuickBooks already holds (docs/08 §17).
 *
 * Three properties every voider below shares, because each one is a way this
 * can go wrong:
 *
 *  1. **Nothing there is nothing to do.** A document voided before it ever
 *     reached QuickBooks has no mapping, and the void is a no-op — not a
 *     failure, and not something to block on. The create syncers refuse to send
 *     a locally-voided document, so there is no race where the create lands
 *     afterwards.
 *  2. **Already reversed is success.** The remote document is read first. If
 *     somebody voided it in QuickBooks before we got there, the desired state is
 *     already true and the job reconciles rather than fighting over it (§10).
 *  3. **Materially different is a conflict, not an overwrite.** If their copy
 *     has been edited into something else, that is `EXTERNAL_CONFLICT` for a
 *     person to look at.
 */

/** What a voider found on the QuickBooks side before acting. */
type RemoteState<T> =
  | { kind: 'ABSENT' }
  | { kind: 'ALREADY_REVERSED'; externalId: string; syncToken: string | null }
  | { kind: 'LIVE'; document: T; externalId: string; syncToken: string }

const NOTHING_TO_DO: SyncerResult = {
  externalId: 'NOT_APPLICABLE',
  syncToken: null,
  sourceHash: 'void:nothing-in-quickbooks',
  reconciliation: null,
  taxProvenance: 'SNAPSHOT',
}

/** A voided QuickBooks document carries `void`, or has simply been zeroed. */
function looksReversed(document: { void?: boolean; TotalAmt?: number } | null): boolean {
  if (!document) return false
  return document.void === true || Number(document.TotalAmt ?? 0) === 0
}

async function remoteFor<T extends { Id?: string; SyncToken?: string; void?: boolean; TotalAmt?: number }>(
  ctx: SyncContext,
  entityType: EntityType,
  localId: string,
  fetch: (id: string) => Promise<T | null>,
): Promise<RemoteState<T>> {
  const mapping = await findMapping(ctx.prisma, entityType, localId)
  if (!mapping?.externalId) return { kind: 'ABSENT' }

  const document = await fetch(mapping.externalId)
  if (!document) {
    // They deleted it themselves. The outcome we wanted is the outcome we have.
    return { kind: 'ALREADY_REVERSED', externalId: mapping.externalId, syncToken: null }
  }
  if (looksReversed(document)) {
    return {
      kind: 'ALREADY_REVERSED',
      externalId: mapping.externalId,
      syncToken: document.SyncToken ?? mapping.externalSyncToken,
    }
  }

  return {
    kind: 'LIVE',
    document,
    externalId: mapping.externalId,
    syncToken: document.SyncToken ?? mapping.externalSyncToken ?? '0',
  }
}

const reversed = (externalId: string, syncToken: string | null): SyncerResult => ({
  externalId,
  syncToken,
  sourceHash: 'void:reversed',
  reconciliation: null,
  taxProvenance: 'SNAPSHOT',
})

/** The reason a person typed, for the note QuickBooks keeps. */
async function voidReasonFor(ctx: SyncContext, entityType: EntityType, localId: string): Promise<string> {
  switch (entityType) {
    case 'Sale': {
      const row = await ctx.prisma.sale.findFirst({ where: { id: localId }, select: { voidReason: true } })
      return row?.voidReason ?? 'Voided'
    }
    case 'CreditMemo': {
      const row = await ctx.prisma.creditMemo.findFirst({ where: { id: localId }, select: { voidReason: true } })
      return row?.voidReason ?? 'Voided'
    }
    case 'Refund': {
      const row = await ctx.prisma.refund.findFirst({ where: { id: localId }, select: { voidReason: true } })
      return row?.voidReason ?? 'Voided'
    }
    case 'Payment': {
      const row = await ctx.prisma.payment.findFirst({ where: { id: localId }, select: { notes: true } })
      return row?.notes ?? 'Reversed'
    }
    default:
      return 'Voided'
  }
}

/**
 * A sale. Invoice and sales receipt both support `operation=void`, so this is
 * the straightforward case: QuickBooks keeps the document, zeroes it and marks
 * it voided, which is exactly what SnackLoad did locally.
 *
 * QuickBooks refuses to void an invoice that still has payments or credits
 * linked to it. That refusal arrives as a validation error and becomes an issue
 * a person can act on — never a workaround that deletes the dependent
 * documents to get the void through.
 */
export const voidSaleSyncer: Syncer = async (ctx, localId, requestId) => {
  const sale = await ctx.prisma.sale.findFirst({
    where: { id: localId },
    select: { saleNumber: true, documentType: true, status: true },
  })
  if (!sale) throw notFound('That sale')

  const isReceipt = sale.documentType === 'SALES_RECEIPT'
  const state = isReceipt
    ? await remoteFor(ctx, 'Sale', localId, (id) => ctx.client.getSalesReceipt(id))
    : await remoteFor(ctx, 'Sale', localId, (id) => ctx.client.getInvoice(id))

  if (state.kind === 'ABSENT') return NOTHING_TO_DO
  if (state.kind === 'ALREADY_REVERSED') return reversed(state.externalId, state.syncToken)

  const result = isReceipt
    ? await ctx.client.voidSalesReceipt(state.externalId, state.syncToken, requestId)
    : await ctx.client.voidInvoice(state.externalId, state.syncToken, requestId)

  return {
    externalId: result.Id ?? state.externalId,
    syncToken: result.SyncToken ?? null,
    sourceHash: 'void:reversed',
    reconciliation: reconcileTotals({
      document: `${sale.saleNumber} (voided)`,
      expectedTotal: '0.00',
      actualTotal: result.TotalAmt,
    }),
    taxProvenance: 'SNAPSHOT',
  }
}

/**
 * A payment reversal. `Payment` supports void, and voiding it is what restores
 * the invoice's open balance on the QuickBooks side — which is why this is a
 * void rather than a second, negative payment. A compensating pair would leave
 * two cash rows on the customer's account for money that only moved once.
 */
export const voidPaymentSyncer: Syncer = async (ctx, localId, requestId) => {
  const state = await remoteFor(ctx, 'Payment', localId, (id) => ctx.client.getPayment(id))
  if (state.kind === 'ABSENT') return NOTHING_TO_DO
  if (state.kind === 'ALREADY_REVERSED') return reversed(state.externalId, state.syncToken)

  const result = await ctx.client.voidPayment(state.externalId, state.syncToken, requestId)
  return {
    externalId: result.Id ?? state.externalId,
    syncToken: result.SyncToken ?? null,
    sourceHash: 'void:reversed',
    reconciliation: reconcileTotals({
      document: 'Reversed payment',
      expectedTotal: '0.00',
      actualTotal: result.TotalAmt,
    }),
    taxProvenance: 'SNAPSHOT',
  }
}

/**
 * Unapplying a credit — **not** the same operation as voiding the credit memo,
 * and confusing the two is how an invoice balance ends up different in the two
 * systems.
 *
 * The application *is* the zero-total Payment that links the credit memo to the
 * invoice. Voiding that Payment releases both links: the invoice goes back up by
 * the applied amount and the credit becomes available again. The credit memo
 * itself is untouched, which is the point.
 */
export const unapplyCreditSyncer: Syncer = async (ctx, localId, requestId) => {
  const state = await remoteFor(ctx, 'CreditMemoApplication', localId, (id) =>
    ctx.client.getPayment(id),
  )
  if (state.kind === 'ABSENT') return NOTHING_TO_DO

  // A linking payment is zero-total to begin with, so "already zero" says
  // nothing. Read the links instead: gone means already unapplied.
  if (state.kind === 'ALREADY_REVERSED') {
    const document = await ctx.client.getPayment(state.externalId)
    const stillLinked = (document?.Line ?? []).some((line) => line.LinkedTxn.length > 0)
    if (!document || !stillLinked) return reversed(state.externalId, state.syncToken)

    const result = await ctx.client.voidPayment(
      state.externalId,
      document.SyncToken ?? state.syncToken ?? '0',
      requestId,
    )
    return reversed(result.Id ?? state.externalId, result.SyncToken ?? null)
  }

  const result = await ctx.client.voidPayment(state.externalId, state.syncToken, requestId)
  return reversed(result.Id ?? state.externalId, result.SyncToken ?? null)
}

/**
 * Voiding a credit memo. QuickBooks has no void verb here, so the memo is
 * reduced to zero in place and marked, keeping its number and its history with
 * nothing left on it to apply.
 *
 * SnackLoad refuses locally to void a credit that is applied or refunded, so by
 * the time this runs the memo is unencumbered on both sides. If QuickBooks
 * still rejects the update because something over there depends on it, that
 * becomes an issue rather than a cascade of deletions.
 */
export const voidCreditMemoSyncer: Syncer = async (ctx, localId, requestId) => {
  const state = await remoteFor(ctx, 'CreditMemo', localId, (id) => ctx.client.getCreditMemo(id))
  if (state.kind === 'ABSENT') return NOTHING_TO_DO
  if (state.kind === 'ALREADY_REVERSED') return reversed(state.externalId, state.syncToken)

  const memo = await ctx.prisma.creditMemo.findFirst({
    where: { id: localId },
    select: { number: true },
  })
  const built = buildVoidedCreditMemo(
    { ...state.document, Id: state.externalId, SyncToken: state.syncToken },
    await voidReasonFor(ctx, 'CreditMemo', localId),
  )
  const result = await ctx.client.updateCreditMemo(built.payload, requestId)

  return {
    externalId: result.Id ?? state.externalId,
    syncToken: result.SyncToken ?? null,
    sourceHash: 'void:reversed',
    reconciliation: reconcileTotals({
      document: `${memo?.number ?? 'Credit memo'} (voided)`,
      expectedTotal: '0.00',
      actualTotal: result.TotalAmt,
      expectedTax: '0.00',
      actualTax: result.TxnTaxDetail?.TotalTax,
    }),
    taxProvenance: 'SNAPSHOT',
  }
}

/**
 * Voiding a refund. Same reasoning as the credit memo: `RefundReceipt` has no
 * void verb, so it is zeroed and marked. The zero-total Payment that linked it
 * to the credit memo is voided first, so the credit becomes available again
 * rather than staying attached to a refund worth nothing.
 */
export const voidRefundSyncer: Syncer = async (ctx, localId, requestId) => {
  const state = await remoteFor(ctx, 'Refund', localId, (id) => ctx.client.getRefundReceipt(id))
  if (state.kind === 'ABSENT') return NOTHING_TO_DO
  if (state.kind === 'ALREADY_REVERSED') return reversed(state.externalId, state.syncToken)

  const refund = await ctx.prisma.refund.findFirst({
    where: { id: localId },
    select: { refundNumber: true },
  })
  const built = buildVoidedRefundReceipt(
    { ...state.document, Id: state.externalId, SyncToken: state.syncToken },
    await voidReasonFor(ctx, 'Refund', localId),
  )
  const result = await ctx.client.updateRefundReceipt(built.payload, requestId)

  return {
    externalId: result.Id ?? state.externalId,
    syncToken: result.SyncToken ?? null,
    sourceHash: 'void:reversed',
    reconciliation: reconcileTotals({
      document: `${refund?.refundNumber ?? 'Refund'} (voided)`,
      expectedTotal: '0.00',
      actualTotal: result.TotalAmt,
      expectedTax: '0.00',
      actualTax: result.TxnTaxDetail?.TotalTax,
    }),
    taxProvenance: 'SNAPSHOT',
  }
}

/**
 * Voiding a COGS journal. `JournalEntry` has no void verb either, and deleting
 * a posted journal is not something to do to a closed period. The answer is the
 * textbook one: a second, opposite entry, so the period nets to nothing and
 * both halves stay readable.
 *
 * The reversal is its own QuickBooks document, so the mapping keeps pointing at
 * the original — that is the document the batch *is*, and the reversal is
 * recorded alongside it in the job's log.
 */
export const voidCogsBatchSyncer: Syncer = async (ctx, localId, requestId) => {
  const mapping = await findMapping(ctx.prisma, 'CogsJournalBatch', localId)
  if (!mapping?.externalId) return NOTHING_TO_DO

  const batch = await ctx.prisma.cogsJournalBatch.findFirst({ where: { id: localId } })
  if (!batch) throw notFound('That COGS batch')

  const missing = missingMappings(ctx.settings, 'cogs')
  if (missing.length > 0) {
    throw new QuickBooksError(
      'MAPPING',
      `Choose the ${missing.map((entry) => entry.label.toLowerCase()).join(' and ')} before a COGS journal can be reversed.`,
    )
  }

  const built = buildReversingJournal(
    {
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      totalCogs: toAmountString(batch.totalCogs),
      batchId: batch.id,
    },
    ctx.settings,
    'Voided in SnackLoad',
  )

  const result = await ctx.client.createJournalEntry(built.payload, requestId)

  return {
    // Still the original. The reversal is a second document, not a replacement.
    externalId: mapping.externalId,
    syncToken: mapping.externalSyncToken,
    sourceHash: `void:reversed:${result.Id}`,
    reconciliation: reconcileTotals({
      document: `COGS reversal ${built.payload.TxnDate}`,
      expectedTotal: built.expected.total,
      actualTotal: result.TotalAmt ?? Number(built.expected.total),
    }),
    taxProvenance: 'SNAPSHOT',
  }
}

/**
 * A return's void reaches QuickBooks through its credit memo, because that is
 * where its money lives (docs/07 §5). The goods document has no QuickBooks
 * object to reverse.
 */
export const VOIDERS: Partial<Record<EntityType, Syncer>> = {
  Sale: voidSaleSyncer,
  Payment: voidPaymentSyncer,
  CreditMemo: voidCreditMemoSyncer,
  CreditMemoApplication: unapplyCreditSyncer,
  Refund: voidRefundSyncer,
  CogsJournalBatch: voidCogsBatchSyncer,
}
