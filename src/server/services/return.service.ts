import { Prisma } from '@/generated/prisma/client'
import type {
  InventoryLocationKind,
  InventoryTransactionType,
  ReturnDisposition,
} from '@/generated/prisma/enums'
import { db, type TenantDb, type TenantTx } from '@/server/db/tenant'
import type { RawCapable } from '@/server/db/tx'
import type { AuthContext } from '@/server/auth/context'
import { can, requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'
import { m, round2, toAmountString } from '@/server/domain/money'
import {
  assertCreditIdentity,
  creditForReturn,
  remainingReturnable,
  totalCredit,
  type CreditedLine,
} from '@/server/domain/returnMath'
import { nextDocumentNumber, postInventoryTransaction } from './inventory.service'
import { writeAudit } from './audit.service'
import { enqueueIfConnected } from '@/server/integrations/quickbooks/sync/hooks'
import { applyCreditMemo, issueRefund, snapshotParties } from './credit.service'
import { pluralize } from '@/server/domain/uom'
import type { CreateReturnInput } from '@/lib/schemas/returns'

/**
 * Returns (spec §1–§6).
 *
 * The governing rule: **a posted sale is history.** Nothing here edits or
 * deletes a sale line. A return is a new document that references the original,
 * carries its own number, posts its own ledger lines, and produces its own
 * credit. Afterwards the system can answer, separately: what was sold, what came
 * back, why, whether stock returned, where it went, what credit was issued,
 * whether cash was refunded, whether the credit was applied, and who did it.
 *
 * Two independent axes, deliberately not collapsed into one (spec §3):
 *
 *  - **Disposition** — what happens to the goods. Per line, because a return of
 *    three cases can restock two and write one off.
 *  - **Financial action** — what happens to the money. A credit can be applied
 *    to the balance, left on the account, or refunded, and a return can even
 *    issue no credit at all.
 */

/** Where each disposition sends the goods, and what the ledger calls it. */
const DISPOSITIONS: Record<
  ReturnDisposition,
  { ledgerType: InventoryTransactionType; hold: InventoryLocationKind | null; sellable: boolean }
> = {
  RESTOCK_TRUCK: { ledgerType: 'CUSTOMER_RETURN_SELLABLE', hold: null, sellable: true },
  RESTOCK_WAREHOUSE: { ledgerType: 'CUSTOMER_RETURN_SELLABLE', hold: null, sellable: true },
  DAMAGED: { ledgerType: 'CUSTOMER_RETURN_DAMAGED', hold: 'DAMAGED_HOLD', sellable: false },
  EXPIRED: { ledgerType: 'CUSTOMER_RETURN_EXPIRED', hold: 'EXPIRED_HOLD', sellable: false },
  SUPPLIER_RETURN: {
    ledgerType: 'CUSTOMER_RETURN_SUPPLIER',
    hold: 'SUPPLIER_RETURN_HOLD',
    sellable: false,
  },
  NONE: { ledgerType: 'CUSTOMER_RETURN_SELLABLE', hold: null, sellable: false },
}

const HOLD_NAMES: Record<string, string> = {
  DAMAGED_HOLD: 'Damaged goods',
  EXPIRED_HOLD: 'Expired goods',
  SUPPLIER_RETURN_HOLD: 'Supplier returns',
}

export type ReturnableLine = {
  saleItemId: string
  productId: string
  productUomId: string
  name: string
  sku: string
  uomLabel: string
  baseUnitsPerUom: number
  /** Whole units of the sold UoM. */
  soldQuantity: number
  soldBaseQuantity: number
  returnedBaseQuantity: number
  /** What may still come back, in the sold UoM, rounded down. */
  returnableQuantity: number
  returnableBaseQuantity: number
  unitPrice: string
  lineTotal: string
}

/**
 * What is still returnable against a sale (spec §1).
 *
 * Sold minus everything already returned on live returns. A voided return is
 * not counted: its goods went back out and its credit was reversed, so those
 * units are returnable again.
 */
export async function getReturnableLines(
  ctx: AuthContext,
  saleId: string,
): Promise<{ saleNumber: string; customerId: string; customerName: string; lines: ReturnableLine[] }> {
  requirePermission(ctx, 'return:create')
  const prisma = db(ctx)

  const sale = await prisma.sale.findFirst({
    where: { id: saleId },
    select: {
      id: true, saleNumber: true, status: true, soldByUserId: true,
      customer: { select: { id: true, name: true } },
      items: {
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true, productId: true, productUomId: true, quantity: true, baseQuantity: true,
          productNameSnapshot: true, skuSnapshot: true, uomLabelSnapshot: true,
          unitPrice: true, lineTotal: true,
          productUom: { select: { baseUnitsPerUom: true } },
        },
      },
    },
  })
  if (!sale) throw notFound('That sale')
  if (!can(ctx, 'sale:read') && sale.soldByUserId !== ctx.userId) throw notFound('That sale')
  if (sale.status !== 'COMPLETED') {
    throw conflict('Only a completed sale can be returned against.')
  }

  const returned = await returnedBySaleItem(prisma, sale.items.map((i) => i.id))

  return {
    saleNumber: sale.saleNumber,
    customerId: sale.customer.id,
    customerName: sale.customer.name,
    lines: sale.items.map((item) => {
      const already = returned.get(item.id) ?? 0
      const returnableBase = remainingReturnable(item.baseQuantity, already)
      const perUom = Math.max(1, item.productUom.baseUnitsPerUom)

      return {
        saleItemId: item.id,
        productId: item.productId,
        productUomId: item.productUomId,
        name: item.productNameSnapshot,
        sku: item.skuSnapshot,
        uomLabel: item.uomLabelSnapshot,
        baseUnitsPerUom: perUom,
        soldQuantity: item.quantity,
        soldBaseQuantity: item.baseQuantity,
        returnedBaseQuantity: already,
        returnableQuantity: Math.floor(returnableBase / perUom),
        returnableBaseQuantity: returnableBase,
        unitPrice: toAmountString(item.unitPrice),
        lineTotal: toAmountString(item.lineTotal),
      }
    }),
  }
}

export type ReturnResult = {
  returnId: string
  returnNumber: string
  creditMemoId: string | null
  creditMemoNumber: string | null
  creditTotal: string
  applied: string
  refunded: string
  remainingCredit: string
  replayed: boolean
}

export async function createReturn(
  ctx: AuthContext,
  input: CreateReturnInput,
): Promise<ReturnResult> {
  requirePermission(ctx, 'return:create')
  if (input.financialAction !== 'NONE') requirePermission(ctx, 'credit:create')
  // Handing over cash is a separate grant from taking goods back (spec §17).
  if (input.financialAction === 'REFUND') requirePermission(ctx, 'refund:create')

  const prisma = db(ctx)

  const replay = await prisma.return.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: {
      id: true, returnNumber: true, total: true,
      creditMemo: { select: { id: true, number: true, amount: true, remainingAmount: true, refundedAmount: true } },
    },
  })
  if (replay) {
    return {
      returnId: replay.id,
      returnNumber: replay.returnNumber,
      creditMemoId: replay.creditMemo?.id ?? null,
      creditMemoNumber: replay.creditMemo?.number ?? null,
      creditTotal: toAmountString(replay.creditMemo?.amount ?? 0),
      applied: toAmountString(
        m(replay.creditMemo?.amount ?? 0)
          .minus(replay.creditMemo?.remainingAmount ?? 0)
          .minus(replay.creditMemo?.refundedAmount ?? 0),
      ),
      refunded: toAmountString(replay.creditMemo?.refundedAmount ?? 0),
      remainingCredit: toAmountString(replay.creditMemo?.remainingAmount ?? 0),
      replayed: true,
    }
  }

  const sale = await prisma.sale.findFirst({
    where: { id: input.saleId },
    select: {
      id: true, saleNumber: true, status: true, customerId: true, taxJson: true,
      customer: { select: { id: true, name: true } },
      items: {
        select: {
          id: true, productId: true, productUomId: true, baseQuantity: true,
          productNameSnapshot: true, skuSnapshot: true, uomLabelSnapshot: true,
          unitPrice: true, lineSubtotal: true, discountAmount: true, taxAmount: true,
          taxable: true, taxableAmount: true, taxRateApplied: true,
          lineTotal: true, unitCostAtSale: true,
          productUom: { select: { baseUnitsPerUom: true } },
        },
      },
      transaction: { select: { lines: { select: { productId: true, locationId: true } } } },
    },
  })
  if (!sale) throw notFound('That sale')
  if (sale.status !== 'COMPLETED') throw conflict('Only a completed sale can be returned against.')

  const itemById = new Map(sale.items.map((item) => [item.id, item]))

  // Where the goods went out from, so "restock the truck" means the truck they
  // actually left on rather than whichever one is handy today.
  const soldFrom = new Map((sale.transaction?.lines ?? []).map((l) => [l.productId, l.locationId]))

  // ── Validate and price every line before anything is written ──────────────
  type Prepared = {
    saleItemId: string
    productId: string
    productUomId: string
    name: string
    sku: string
    uomLabel: string
    quantity: number
    baseQuantity: number
    disposition: ReturnDisposition
    reason: CreateReturnInput['reason']
    credit: CreditedLine
  }

  const requestedByItem = new Map<string, number>()
  for (const line of input.lines) {
    const item = itemById.get(line.saleItemId)
    if (!item) throw conflict('That line is not on this sale.')
    const perUom = Math.max(1, item.productUom.baseUnitsPerUom)
    requestedByItem.set(item.id, (requestedByItem.get(item.id) ?? 0) + line.quantity * perUom)
  }

  const checks: ReturnableCheck[] = [...requestedByItem].map(([saleItemId, requested]) => {
    const item = itemById.get(saleItemId)!
    return {
      saleItemId,
      name: item.productNameSnapshot,
      uomLabel: item.uomLabelSnapshot,
      baseUnitsPerUom: Math.max(1, item.productUom.baseUnitsPerUom),
      soldBaseQuantity: item.baseQuantity,
      requestedBaseQuantity: requested,
    }
  })

  // A first, unlocked check: it fails a hopeless request before any pricing
  // work, and it is the one that usually fires. It is NOT the guard — the guard
  // is the identical check under the row lock inside the transaction below.
  assertReturnable(sale.saleNumber, checks, await returnedBySaleItem(prisma, [...requestedByItem.keys()]))

  const prepared: Prepared[] = input.lines.map((line) => {
    const item = itemById.get(line.saleItemId)!
    const perUom = Math.max(1, item.productUom.baseUnitsPerUom)
    const baseQuantity = line.quantity * perUom

    return {
      saleItemId: item.id,
      productId: item.productId,
      productUomId: item.productUomId,
      name: item.productNameSnapshot,
      sku: item.skuSnapshot,
      uomLabel: item.uomLabelSnapshot,
      quantity: line.quantity,
      baseQuantity,
      disposition: line.disposition,
      reason: line.reason ?? input.reason,
      credit: creditForReturn(
        {
          baseQuantity: item.baseQuantity,
          unitPrice: toAmountString(item.unitPrice),
          lineSubtotal: toAmountString(item.lineSubtotal),
          discountAmount: toAmountString(item.discountAmount),
          taxable: item.taxable,
          taxableAmount: toAmountString(item.taxableAmount),
          taxRateApplied: item.taxRateApplied.toString(),
          taxAmount: toAmountString(item.taxAmount),
          lineTotal: toAmountString(item.lineTotal),
          unitCostAtSale: item.unitCostAtSale.toString(),
        },
        baseQuantity,
      ),
    }
  })

  const totals = totalCredit(prepared.map((p) => p.credit))
  assertCreditIdentity(prepared.map((p) => p.credit), totals)

  const issuesCredit = input.financialAction !== 'NONE' && m(totals.total).greaterThan(0)
  const parties = issuesCredit ? await snapshotParties(ctx, sale.customer.id) : null

  const occurredAt = new Date()

  const outcome = await prisma.$transaction(async (tx) => {
    // ── The guard (spec §1) ────────────────────────────────────────────────
    // Lock the sale lines this return draws down, then count what has already
    // come back *under that lock*. Everything above this point is advisory; a
    // returnable quantity read outside the writing transaction is a guess, and
    // two runners crediting the same last case would both have been told yes.
    // Same standard as the ledger's balance rows (docs/02 §L4).
    await lockSaleItems(tx, ctx.organizationId, [...requestedByItem.keys()])
    assertReturnable(
      sale.saleNumber,
      checks,
      await returnedBySaleItem(tx, [...requestedByItem.keys()]),
    )

    const returnNumber = await nextDocumentNumber(tx, ctx.organizationId, 'RETURN')

    // ── Credit memo ────────────────────────────────────────────────────────
    let creditMemoId: string | null = null
    let creditMemoNumber: string | null = null

    if (issuesCredit) {
      creditMemoNumber = await nextDocumentNumber(tx, ctx.organizationId, 'CREDIT_MEMO')
      const memo = await tx.creditMemo.create({
        data: {
          organizationId: ctx.organizationId,
          customerId: sale.customer.id,
          number: creditMemoNumber,
          saleId: sale.id,
          issuedByUserId: ctx.userId,
          reason: input.reason,
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          taxTotal: totals.taxTotal,
          amount: totals.total,
          remainingAmount: totals.total,
          issuedAt: occurredAt,
          notes: input.notes || null,
          billToJson: parties!.billTo,
          issuerJson: parties!.issuer,
          // The regime the ORIGINAL sale was posted under, carried across so a
          // credit says which tax it reverses without anyone consulting the
          // customer's settings as they stand today (docs/02 §M4).
          taxJson: (sale.taxJson ?? undefined) as Prisma.InputJsonValue | undefined,
          items: {
            create: prepared.map((p, index) => ({
              organizationId: ctx.organizationId,
              saleItemId: p.saleItemId,
              productId: p.productId,
              productUomId: p.productUomId,
              descriptionSnapshot: p.name,
              skuSnapshot: p.sku,
              uomLabelSnapshot: p.uomLabel,
              quantity: p.quantity,
              baseQuantity: p.baseQuantity,
              unitPrice: p.credit.unitPrice,
              lineSubtotal: p.credit.lineSubtotal,
              discountAmount: p.credit.discountAmount,
              taxableAmount: p.credit.taxableAmount,
              taxRateApplied: p.credit.taxRateApplied,
              taxAmount: p.credit.taxAmount,
              lineTotal: p.credit.lineTotal,
              // The line's taxability as it was SOLD. Deriving it from
              // "tax > 0" got this wrong for an exempt buyer: nothing was
              // charged, but the goods were never non-taxable.
              taxable: p.credit.taxable,
              // Only reversed when the goods physically came back.
              unitCostAtSale:
                p.disposition === 'NONE' ? '0' : p.credit.unitCostAtSale,
              reason: p.reason,
              sortOrder: index,
            })),
          },
        },
        select: { id: true },
      })
      creditMemoId = memo.id
    }

    // ── Inventory, one transaction per disposition ──────────────────────────
    const transactionByDisposition = new Map<ReturnDisposition, string>()
    const locationByDisposition = new Map<ReturnDisposition, string>()

    const byDisposition = new Map<ReturnDisposition, Prepared[]>()
    for (const p of prepared) {
      if (p.disposition === 'NONE') continue
      const bucket = byDisposition.get(p.disposition) ?? []
      bucket.push(p)
      byDisposition.set(p.disposition, bucket)
    }

    for (const [disposition, items] of byDisposition) {
      const spec = DISPOSITIONS[disposition]

      // Resolve one destination for the whole group. Restocking goes back where
      // the goods came from; everything else lands in a hold location that is
      // not sellable, so a damaged case never becomes truck stock again.
      const destination =
        disposition === 'RESTOCK_TRUCK'
          ? soldFrom.get(items[0].productId) ?? (await defaultTruckLocation(tx, ctx))
          : disposition === 'RESTOCK_WAREHOUSE'
            ? await warehouseLocation(tx, ctx.organizationId)
            : await holdLocation(tx, ctx.organizationId, spec.hold!)

      const posted = await postInventoryTransaction(tx, ctx.organizationId, {
        type: spec.ledgerType,
        occurredAt,
        createdByUserId: ctx.userId,
        referenceType: 'Return',
        idempotencyKey: `return:${input.idempotencyKey}:${disposition}`,
        notes: `${returnNumber} from ${sale.saleNumber}`,
        lines: items.map((item) => ({
          productId: item.productId,
          locationId: destination,
          quantityDelta: item.baseQuantity,
          // Goods come back in at the cost they left at, so a return does not
          // quietly restate the moving average (docs/02 §L5).
          unitCost: item.credit.unitCostAtSale,
        })),
      })

      transactionByDisposition.set(disposition, posted.transactionId)
      locationByDisposition.set(disposition, destination)
    }

    // ── The return document ────────────────────────────────────────────────
    const created = await tx.return.create({
      data: {
        organizationId: ctx.organizationId,
        returnNumber,
        customerId: sale.customer.id,
        saleId: sale.id,
        routeStopId: input.routeStopId || null,
        createdByUserId: ctx.userId,
        occurredAt,
        reason: input.reason,
        financialAction: input.financialAction,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        creditMemoId,
        idempotencyKey: input.idempotencyKey,
        notes: input.notes || null,
        items: {
          create: prepared.map((p) => ({
            organizationId: ctx.organizationId,
            saleItemId: p.saleItemId,
            productId: p.productId,
            productUomId: p.productUomId,
            productNameSnapshot: p.name,
            skuSnapshot: p.sku,
            uomLabelSnapshot: p.uomLabel,
            quantity: p.quantity,
            baseQuantity: p.baseQuantity,
            unitCostAtSale: p.credit.unitCostAtSale,
            disposition: p.disposition,
            reason: p.reason,
            locationId: locationByDisposition.get(p.disposition) ?? null,
            inventoryTransactionId: transactionByDisposition.get(p.disposition) ?? null,
          })),
        },
      },
      select: { id: true },
    })

    for (const transactionId of transactionByDisposition.values()) {
      await tx.inventoryTransaction.update({
        where: { id: transactionId },
        data: { referenceId: created.id },
      })
    }

    // The goods document has no QuickBooks equivalent and should not have one:
    // its money is the credit memo, and syncing both would double-count it
    // (docs/07 §5). Only the credit is queued.
    if (creditMemoId) {
      await enqueueIfConnected(tx, ctx.organizationId, {
        entityType: 'CreditMemo',
        localId: creditMemoId,
        operation: 'CREATE',
      })
    }

    await writeAudit(tx, ctx, {
      action: 'return.created',
      entityType: 'Return',
      entityId: created.id,
      after: {
        returnNumber,
        saleNumber: sale.saleNumber,
        customerName: sale.customer.name,
        reason: input.reason,
        financialAction: input.financialAction,
        total: totals.total,
        lines: prepared.map((p) => ({
          product: p.name,
          quantity: p.quantity,
          disposition: p.disposition,
          reason: p.reason,
        })),
      },
    })

    return { returnId: created.id, returnNumber, creditMemoId, creditMemoNumber }
  })

  // ── What the money does next ───────────────────────────────────────────────
  // Deliberately after the return has committed: applying a credit and issuing
  // a refund are their own documents with their own audit rows, and a failure
  // in either must not roll back goods that have physically changed hands.
  let applied = m(0)
  let refunded = m(0)
  let remaining = m(totals.total)

  if (outcome.creditMemoId) {
    if (input.financialAction === 'APPLY_TO_BALANCE') {
      const result = await applyCreditMemo(ctx, { creditMemoId: outcome.creditMemoId })
      applied = m(result.applied)
      remaining = m(result.remaining)
    }

    if (input.financialAction === 'REFUND') {
      const result = await issueRefund(ctx, {
        creditMemoId: outcome.creditMemoId,
        amount: totals.total,
        method: input.refund?.method ?? 'CASH',
        referenceNumber: input.refund?.referenceNumber || undefined,
        notes: input.refund?.notes || undefined,
        idempotencyKey: `${input.idempotencyKey}`,
      })
      refunded = m(result.amount)
      remaining = m(result.remainingCredit)
    }
  }

  return {
    returnId: outcome.returnId,
    returnNumber: outcome.returnNumber,
    creditMemoId: outcome.creditMemoId,
    creditMemoNumber: outcome.creditMemoNumber,
    creditTotal: totals.total,
    applied: toAmountString(applied),
    refunded: toAmountString(refunded),
    remainingCredit: toAmountString(remaining),
    replayed: false,
  }
}

/**
 * Voiding a return (spec §9).
 *
 * Never a delete. Stock that came back goes out again, the credit memo is
 * voided, and the original documents stay readable. A credit that has already
 * been spent — applied to an invoice or refunded in cash — blocks the void:
 * unwinding it would leave an invoice paid by money that no longer exists.
 * The dependent documents have to be reversed first, and the error says so.
 */
export async function voidReturn(
  ctx: AuthContext,
  returnId: string,
  reason: string,
): Promise<void> {
  requirePermission(ctx, 'return:void')
  const prisma = db(ctx)

  const row = await prisma.return.findFirst({
    where: { id: returnId },
    select: {
      id: true, returnNumber: true, status: true, customerId: true,
      creditMemoId: true,
      creditMemo: {
        select: {
          id: true, number: true, amount: true, remainingAmount: true, refundedAmount: true,
          status: true,
          applications: { where: { status: 'APPLIED' }, select: { id: true } },
          refunds: { where: { status: 'POSTED' }, select: { id: true, refundNumber: true } },
        },
      },
      items: {
        select: {
          id: true, productId: true, baseQuantity: true, disposition: true,
          locationId: true, inventoryTransactionId: true, unitCostAtSale: true,
        },
      },
    },
  })
  if (!row) throw notFound('That return')
  if (row.status !== 'COMPLETED') throw conflict('That return has already been voided.')

  const memo = row.creditMemo
  if (memo) {
    if (memo.refunds.length > 0) {
      throw conflict(
        `${memo.number} has already been refunded (${memo.refunds.map((r) => r.refundNumber).join(', ')}). ` +
          'Void the refund first, then void the return.',
      )
    }
    if (memo.applications.length > 0) {
      throw conflict(
        `${memo.number} has already been applied to an invoice. Unapply the credit first, then void the return.`,
      )
    }
  }

  await prisma.$transaction(async (tx) => {
    // Send the goods back out of whatever location they landed in.
    const byTransaction = new Map<string, typeof row.items>()
    for (const item of row.items) {
      if (!item.inventoryTransactionId || !item.locationId) continue
      const bucket = byTransaction.get(item.inventoryTransactionId) ?? []
      bucket.push(item)
      byTransaction.set(item.inventoryTransactionId, bucket)
    }

    for (const [transactionId, items] of byTransaction) {
      await postInventoryTransaction(tx, ctx.organizationId, {
        type: 'REVERSAL',
        createdByUserId: ctx.userId,
        referenceType: 'Return',
        referenceId: row.id,
        reversalOfId: transactionId,
        notes: `Void of ${row.returnNumber}: ${reason}`,
        lines: items.map((item) => ({
          productId: item.productId,
          locationId: item.locationId!,
          quantityDelta: -item.baseQuantity,
        })),
      })
    }

    if (memo) {
      await tx.creditMemo.update({
        where: { id: memo.id },
        data: {
          status: 'VOIDED',
          remainingAmount: '0',
          voidedAt: new Date(),
          voidedByUserId: ctx.userId,
          voidReason: reason,
        },
      })
    }

    await tx.return.update({
      where: { id: row.id },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason: reason,
      },
    })

    await writeAudit(tx, ctx, {
      action: 'return.voided',
      entityType: 'Return',
      entityId: row.id,
      after: { returnNumber: row.returnNumber, reason, creditMemo: memo?.number ?? null },
    })
  })
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type ReturnableCheck = {
  saleItemId: string
  name: string
  uomLabel: string
  baseUnitsPerUom: number
  soldBaseQuantity: number
  requestedBaseQuantity: number
}

/**
 * The returnable-quantity rule: sold minus what has already come back.
 *
 * Pure, and called twice on purpose — once unlocked to fail fast, once under
 * the sale-line lock inside the writing transaction, where it is authoritative.
 * Sharing one function is what stops the advisory answer and the real one from
 * drifting apart.
 */
function assertReturnable(
  saleNumber: string,
  checks: ReturnableCheck[],
  alreadyReturned: Map<string, number>,
): void {
  for (const check of checks) {
    const returnable = remainingReturnable(
      check.soldBaseQuantity,
      alreadyReturned.get(check.saleItemId) ?? 0,
    )
    if (check.requestedBaseQuantity > returnable) {
      // The server is the authority. A client that never renders the limit, or
      // one crafted to ignore it, is refused here (spec §22 scenario E).
      const left = Math.floor(returnable / check.baseUnitsPerUom)
      throw conflict(
        `${check.name}: only ${left} ${pluralize(left, check.uomLabel.toLowerCase())} can still be returned from ${saleNumber}.`,
      )
    }
  }
}

/**
 * Locks the sale lines a return is about to draw down.
 *
 * `FOR UPDATE` on the sale lines themselves rather than on the returns that
 * reference them: the rows being counted do not exist yet, so there is nothing
 * else for a competing transaction to collide on. Sale lines are immutable
 * history, so the lock costs nothing but the serialisation it exists for.
 *
 * Ordered by id, the same discipline `postInventoryTransaction` uses on balance
 * rows: two returns overlapping on two lines take the locks in the same order,
 * so one waits instead of each holding what the other needs.
 */
async function lockSaleItems(
  tx: RawCapable,
  organizationId: string,
  saleItemIds: string[],
): Promise<void> {
  if (saleItemIds.length === 0) return

  const ordered = [...saleItemIds].sort()
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id
      FROM sale_item
     WHERE organization_id = ${organizationId}
       AND id IN (${Prisma.join(ordered)})
     ORDER BY id
     FOR UPDATE
  `)

  if (rows.length !== ordered.length) throw conflict('That line is not on this sale.')
}

/** Base units already returned per sale line, counting live returns only. */
async function returnedBySaleItem(
  prisma: Pick<TenantDb | TenantTx, 'returnItem'>,
  saleItemIds: string[],
): Promise<Map<string, number>> {
  if (saleItemIds.length === 0) return new Map()

  const rows = await prisma.returnItem.groupBy({
    by: ['saleItemId'],
    where: { saleItemId: { in: saleItemIds }, return: { status: 'COMPLETED' } },
    _sum: { baseQuantity: true },
  })

  return new Map(
    rows
      .filter((r): r is typeof r & { saleItemId: string } => r.saleItemId !== null)
      .map((r) => [r.saleItemId, r._sum.baseQuantity ?? 0]),
  )
}

/**
 * A non-sellable holding location, created on first use.
 *
 * Lazily rather than at provisioning, so an organization that never takes back
 * a damaged case never grows a location it does not use — and so organizations
 * that existed before this phase get one the moment they need it.
 */
async function holdLocation(
  tx: TenantTx,
  organizationId: string,
  kind: InventoryLocationKind,
): Promise<string> {
  const existing = await tx.inventoryLocation.findFirst({
    where: { kind, active: true },
    select: { id: true },
  })
  if (existing) return existing.id

  const created = await tx.inventoryLocation.create({
    data: {
      organizationId,
      kind,
      name: HOLD_NAMES[kind] ?? 'Hold',
      sellable: false,
    },
    select: { id: true },
  })
  return created.id
}

async function warehouseLocation(tx: TenantTx, organizationId: string): Promise<string> {
  const warehouse = await tx.inventoryLocation.findFirst({
    where: { kind: 'WAREHOUSE', active: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!warehouse) throw conflict('There is no warehouse to receive this return into.')
  void organizationId
  return warehouse.id
}

/** The truck the person taking the return is driving. */
async function defaultTruckLocation(tx: TenantTx, ctx: AuthContext): Promise<string> {
  const membership = await tx.membership.findFirst({
    where: { userId: ctx.userId, status: 'ACTIVE' },
    select: { defaultVehicle: { select: { locationId: true, active: true } } },
  })
  if (membership?.defaultVehicle?.active) return membership.defaultVehicle.locationId

  return warehouseLocation(tx, ctx.organizationId)
}

export { DISPOSITIONS, round2, Prisma }
