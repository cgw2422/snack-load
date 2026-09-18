import { Prisma } from '@/generated/prisma/client'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { can, requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'
import { m, round2, toAmountString } from '@/server/domain/money'
import { assertTotalsIdentity, computeSaleTotals, dueDateFor } from '@/server/domain/saleMath'
import { resolvePrice, type PriceSource } from '@/server/domain/pricing'
import { allocateOldestFirst } from '@/server/domain/allocation'
import { buildTaxSnapshot, type TaxSnapshot } from '@/server/domain/taxSnapshot'
import { nextDocumentNumber, postInventoryTransaction } from './inventory.service'
import { writeAudit } from './audit.service'
import { enqueueIfConnected } from '@/server/integrations/quickbooks/sync/hooks'
import type { CheckoutInput, ReceiptQuery } from '@/lib/schemas/sales'
import { dateOnly, endOfDayInZone, startOfDayInZone } from '@/lib/dates'

/**
 * Selling at the store (spec §22).
 *
 * The server is the sole authority on price, tax, stock and document numbers.
 * A client sends intent — customer, product, unit, quantity — and never a
 * computed total. That is what makes an offline queue safe later (docs/05 §3),
 * and what stops a crafted request from inventing a price today.
 */

export type PricedLine = {
  productId: string
  productUomId: string
  productName: string
  sku: string
  uomLabel: string
  baseUnitsPerUom: number
  quantity: number
  baseQuantity: number
  unitPrice: string
  priceSource: PriceSource
  lineSubtotal: string
  discountAmount: string
  taxAmount: string
  lineTotal: string
  taxable: boolean
  /** The basis tax applies to. Carried even on an exempt sale (docs/02 §M4). */
  taxableAmount: string
  /** The rate actually applied to this line. Zero when exempt or non-taxable. */
  taxRateApplied: string
  /** What is on the selling location right now, for the "only 3 left" warning. */
  available: number
}

export type PricedCart = {
  customerId: string
  customerName: string
  taxExempt: boolean
  taxRate: string
  /** The regime this cart is being priced under, snapshotted onto the sale. */
  tax: TaxSnapshot
  lines: PricedLine[]
  subtotal: string
  discountTotal: string
  taxTotal: string
  total: string
  /** Where stock will come off. Resolved server-side, never sent by the client. */
  sellingLocationId: string
  sellingLocationName: string
}

/**
 * Prices a cart without committing anything. The sell screen calls this as the
 * runner adds lines, so what they see is what checkout will charge.
 */
export async function priceCart(
  ctx: AuthContext,
  input: {
    customerId: string
    lines: { productId: string; productUomId: string; quantity: number; manualPrice?: string | null; discountAmount?: string | null }[]
    documentDiscount?: string | null
  },
): Promise<PricedCart> {
  requirePermission(ctx, 'sale:create')
  const prisma = db(ctx)

  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId },
    select: {
      id: true, name: true, active: true, taxExempt: true, taxExemptId: true,
      priceGroupId: true,
      taxRate: { select: { id: true, name: true, code: true, jurisdiction: true, rate: true } },
    },
  })
  if (!customer) throw notFound('That store')
  if (!customer.active) throw conflict(`${customer.name} is not an active account.`)

  const location = await resolveSellingLocation(ctx)

  const uomIds = [...new Set(input.lines.map((l) => l.productUomId))]
  const productIds = [...new Set(input.lines.map((l) => l.productId))]

  const [uoms, customerPrices, groupPrices, balances, defaultRate] = await Promise.all([
    prisma.productUom.findMany({
      where: { id: { in: uomIds } },
      select: {
        id: true, label: true, baseUnitsPerUom: true, price: true, productId: true,
        product: { select: { id: true, name: true, sku: true, taxable: true, active: true } },
      },
    }),
    prisma.customerPrice.findMany({
      where: { customerId: customer.id, productId: { in: productIds } },
      select: { productId: true, productUomId: true, price: true, effectiveFrom: true, effectiveTo: true },
    }),
    customer.priceGroupId
      ? prisma.priceGroupPrice.findMany({
          where: { priceGroupId: customer.priceGroupId, productId: { in: productIds } },
          select: { productId: true, productUomId: true, price: true, effectiveFrom: true, effectiveTo: true },
        })
      : [],
    prisma.inventoryBalance.findMany({
      where: { locationId: location.id, productId: { in: productIds } },
      select: { productId: true, quantity: true },
    }),
    prisma.taxRate.findFirst({
      where: { isDefault: true },
      select: { id: true, name: true, code: true, jurisdiction: true, rate: true },
    }),
  ])

  const uomById = new Map(uoms.map((u) => [u.id, u]))
  const onHand = new Map(balances.map((b) => [b.productId, b.quantity]))
  // The customer's own rate wins; otherwise the organization's default. Which
  // one it was gets frozen onto the sale, so nobody has to re-run this choice
  // against settings that have since moved (docs/02 §M4).
  const appliedRate = customer.taxRate ?? defaultRate ?? null
  const taxRate = appliedRate?.rate ?? m(0)
  const taxSnapshot = buildTaxSnapshot({
    rate: appliedRate,
    exempt: customer.taxExempt,
    exemptId: customer.taxExemptId,
  })

  const canOverride = can(ctx, 'price:override')

  const resolved = input.lines.map((line) => {
    const uom = uomById.get(line.productUomId)
    if (!uom) throw notFound('That unit of measure')
    if (uom.productId !== line.productId) {
      throw conflict(`"${uom.label}" does not belong to ${uom.product.name}.`)
    }
    if (!uom.product.active) throw conflict(`${uom.product.name} is no longer active.`)

    const price = resolvePrice({
      productUomId: uom.id,
      listPrice: uom.price,
      customerPrices: customerPrices.filter((p) => p.productId === line.productId),
      priceGroupPrices: groupPrices.filter((p) => p.productId === line.productId),
      // A price typed by someone without the permission is simply ignored.
      manualPrice: canOverride ? (line.manualPrice ?? null) : null,
    })

    return { line, uom, price }
  })

  const totals = computeSaleTotals({
    taxRate,
    taxExempt: customer.taxExempt,
    documentDiscount: input.documentDiscount ?? 0,
    lines: resolved.map((r) => ({
      quantity: r.line.quantity,
      baseUnitsPerUom: r.uom.baseUnitsPerUom,
      unitPrice: r.price.price,
      discountAmount: r.line.discountAmount ?? 0,
      taxable: r.uom.product.taxable,
    })),
  })
  assertTotalsIdentity(totals)

  return {
    customerId: customer.id,
    customerName: customer.name,
    taxExempt: customer.taxExempt,
    taxRate: m(taxRate).toString(),
    tax: taxSnapshot,
    sellingLocationId: location.id,
    sellingLocationName: location.name,
    lines: resolved.map((r, i) => {
      const computed = totals.lines[i]
      return {
        productId: r.line.productId,
        productUomId: r.uom.id,
        productName: r.uom.product.name,
        sku: r.uom.product.sku,
        uomLabel: r.uom.label,
        baseUnitsPerUom: r.uom.baseUnitsPerUom,
        quantity: r.line.quantity,
        baseQuantity: computed.baseQuantity,
        unitPrice: toAmountString(computed.unitPrice),
        priceSource: r.price.source,
        lineSubtotal: toAmountString(computed.lineSubtotal),
        discountAmount: toAmountString(computed.discountAmount),
        taxAmount: toAmountString(computed.taxAmount),
        lineTotal: toAmountString(computed.lineTotal),
        taxable: r.uom.product.taxable,
        // Zero on goods that were never taxable; the full basis on taxable
        // goods sold to an exempt buyer, which is the figure an exemption
        // report needs and the one today's settings would destroy.
        taxableAmount: toAmountString(r.uom.product.taxable ? computed.taxableBase : 0),
        taxRateApplied: r.uom.product.taxable ? m(taxSnapshot.rate).toString() : '0',
        available: onHand.get(r.line.productId) ?? 0,
      }
    }),
    subtotal: toAmountString(totals.subtotal),
    discountTotal: toAmountString(totals.discountTotal),
    taxTotal: toAmountString(totals.taxTotal),
    total: toAmountString(totals.total),
  }
}

export type CheckoutResult = {
  saleId: string
  saleNumber: string
  receiptNumber: string
  total: string
  amountPaid: string
  balanceDue: string
  replayed: boolean
}

/**
 * Committing the sale.
 *
 * One database transaction covers: document numbers from the locked sequence,
 * stock off the selling location through the ledger, the sale and its lines
 * with cost snapshotted for COGS, any payment and its allocation, the customer
 * balance, the signature, the audit row, and the stop's outcome. Either all of
 * it happened or none of it did.
 */
/**
 * Flattens a store or company into the shape a receipt header needs. Stored on
 * the sale as JSON, never read back through a relation, so later edits to the
 * source row cannot reach a document that has already been issued.
 */
function snapshotParty(input: {
  name: string
  subtitle: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  phone: string | null
  email: string | null
}): { name: string; subtitle: string | null; addressLines: string[]; phone: string | null; email: string | null } {
  const cityLine = [input.city, input.state].filter(Boolean).join(', ')
  return {
    name: input.name,
    subtitle: input.subtitle,
    addressLines: [
      input.addressLine1,
      input.addressLine2,
      [cityLine, input.postalCode].filter(Boolean).join(' '),
    ].filter((line): line is string => Boolean(line && line.trim())),
    phone: input.phone,
    email: input.email,
  }
}

export async function checkout(
  ctx: AuthContext,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  requirePermission(ctx, 'sale:create')
  const prisma = db(ctx)

  // A retry after a timeout in a dead-zone store returns the original sale
  // rather than billing the store twice (docs/02 §I1).
  const replay = await prisma.sale.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: {
      id: true, saleNumber: true, total: true, amountPaid: true, balanceDue: true,
      receipt: { select: { receiptNumber: true } },
    },
  })
  if (replay) {
    return {
      saleId: replay.id,
      saleNumber: replay.saleNumber,
      receiptNumber: replay.receipt?.receiptNumber ?? '',
      total: toAmountString(replay.total),
      amountPaid: toAmountString(replay.amountPaid),
      balanceDue: toAmountString(replay.balanceDue),
      replayed: true,
    }
  }

  if (input.documentDiscount && !can(ctx, 'sale:discount')) {
    throw conflict('You do not have permission to discount a sale.')
  }

  const cart = await priceCart(ctx, {
    customerId: input.customerId,
    lines: input.lines,
    documentDiscount: input.documentDiscount ?? null,
  })

  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId },
    select: {
      id: true, name: true, paymentTermsCode: true, accountNumber: true,
      addressLine1: true, addressLine2: true, city: true, state: true,
      postalCode: true, phone: true, email: true,
    },
  })
  if (!customer) throw notFound('That store')

  // The header is snapshotted alongside the line items: a store that moves, or
  // a company that rebrands, must not rewrite the receipts already delivered
  // (docs/02 §L5).
  const issuer = await prisma.organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: {
      name: true, legalName: true, phone: true, email: true, logoUrl: true,
      receiptFooter: true, addressLine1: true, addressLine2: true, city: true,
      state: true, postalCode: true,
    },
  })

  const occurredAt = new Date()
  const amountPaid = round2(input.payment?.amount ?? 0)
  const total = m(cart.total)

  if (amountPaid.greaterThan(total)) {
    throw conflict(
      `That is more than the sale total. Take ${toAmountString(total)} here and record the rest as a payment on account.`,
    )
  }

  return prisma.$transaction(async (tx) => {
    const saleNumber = await nextDocumentNumber(tx, ctx.organizationId, 'SALE')
    const receiptNumber = await nextDocumentNumber(tx, ctx.organizationId, 'RECEIPT')

    // Stock comes off first: if the truck is short, nothing else should happen.
    const posted = await postInventoryTransaction(tx, ctx.organizationId, {
      type: 'SALE',
      occurredAt,
      createdByUserId: ctx.userId,
      referenceType: 'Sale',
      idempotencyKey: `sale:${input.idempotencyKey}`,
      lines: cart.lines.map((line) => ({
        productId: line.productId,
        locationId: cart.sellingLocationId,
        quantityDelta: -line.baseQuantity,
      })),
    })

    // COGS is fixed at the moment of sale; a later cost change must not restate
    // a closed month (docs/02 §L5). The ledger line carries the cost that left.
    const costByProduct = new Map(
      (
        await tx.inventoryTransactionLine.findMany({
          where: { transactionId: posted.transactionId },
          select: { productId: true, unitCost: true },
        })
      ).map((l) => [l.productId, l.unitCost]),
    )

    const balanceDue = total.minus(amountPaid)
    const dueDate = dueDateFor(occurredAt, customer.paymentTermsCode)

    const sale = await tx.sale.create({
      data: {
        organizationId: ctx.organizationId,
        saleNumber,
        customerId: customer.id,
        routeStopId: input.routeStopId || null,
        routeId: input.routeStopId
          ? (
              await tx.routeStop.findFirst({
                where: { id: input.routeStopId },
                select: { routeId: true },
              })
            )?.routeId ?? null
          : null,
        soldByUserId: ctx.userId,
        status: 'COMPLETED',
        occurredAt,
        subtotal: cart.subtotal,
        discountTotal: cart.discountTotal,
        taxTotal: cart.taxTotal,
        total: cart.total,
        amountPaid: toAmountString(amountPaid),
        balanceDue: toAmountString(balanceDue),
        dueDate,
        paymentTermsCode: customer.paymentTermsCode,
        taxExempt: cart.taxExempt,
        // Decided here, once. Never recomputed: see the field's comment and
        // docs/07 §2. A sale settled at the counter is a sales receipt for the
        // rest of its life, whatever happens to it afterwards.
        documentType: amountPaid.greaterThanOrEqualTo(total) ? 'SALES_RECEIPT' : 'INVOICE',
        taxJson: cart.tax as unknown as Prisma.InputJsonObject,
        notes: input.notes || null,
        idempotencyKey: input.idempotencyKey,
        inventoryTransactionId: posted.transactionId,
        billToJson: snapshotParty({
          name: customer.name,
          subtitle: `#${customer.accountNumber}`,
          addressLine1: customer.addressLine1,
          addressLine2: customer.addressLine2,
          city: customer.city,
          state: customer.state,
          postalCode: customer.postalCode,
          phone: customer.phone,
          email: customer.email,
        }),
        issuerJson: {
          ...snapshotParty({
            name: issuer.name,
            subtitle: issuer.legalName,
            addressLine1: issuer.addressLine1,
            addressLine2: issuer.addressLine2,
            city: issuer.city,
            state: issuer.state,
            postalCode: issuer.postalCode,
            phone: issuer.phone,
            email: issuer.email,
          }),
          logoUrl: issuer.logoUrl,
          footer: issuer.receiptFooter,
        },
        items: {
          create: cart.lines.map((line, index) => ({
            organizationId: ctx.organizationId,
            productId: line.productId,
            productUomId: line.productUomId,
            productNameSnapshot: line.productName,
            skuSnapshot: line.sku,
            uomLabelSnapshot: line.uomLabel,
            quantity: line.quantity,
            baseQuantity: line.baseQuantity,
            unitPrice: line.unitPrice,
            lineSubtotal: line.lineSubtotal,
            discountAmount: line.discountAmount,
            taxable: line.taxable,
            taxableAmount: line.taxableAmount,
            taxRateApplied: line.taxRateApplied,
            taxAmount: line.taxAmount,
            lineTotal: line.lineTotal,
            unitCostAtSale: costByProduct.get(line.productId)?.toString() ?? '0',
            priceSource: line.priceSource,
            sortOrder: index,
          })),
        },
        receipt: {
          create: { organizationId: ctx.organizationId, receiptNumber, issuedAt: occurredAt },
        },
      },
      select: { id: true },
    })

    await tx.inventoryTransaction.update({
      where: { id: posted.transactionId },
      data: { referenceId: sale.id },
    })

    let payment: { id: string } | null = null
    if (amountPaid.greaterThan(0)) {
      payment = await tx.payment.create({
        data: {
          organizationId: ctx.organizationId,
          customerId: customer.id,
          method: input.payment!.method,
          amount: toAmountString(amountPaid),
          unappliedAmount: '0',
          receivedAt: occurredAt,
          receivedByUserId: ctx.userId,
          routeStopId: input.routeStopId || null,
          checkNumber: input.payment!.checkNumber || null,
          referenceNumber: input.payment!.referenceNumber || null,
          idempotencyKey: `sale:${input.idempotencyKey}`,
        },
        select: { id: true },
      })
      await tx.paymentAllocation.create({
        data: {
          organizationId: ctx.organizationId,
          paymentId: payment.id,
          saleId: sale.id,
          amount: toAmountString(amountPaid),
        },
      })
    }

    if (input.signature?.imageDataUrl) {
      await tx.signature.create({
        data: {
          organizationId: ctx.organizationId,
          saleId: sale.id,
          signerName: input.signature.signerName || null,
          imagePng: decodeDataUrl(input.signature.imageDataUrl),
        },
      })
    }

    // Customer.balance is a cache of open AR (docs/02 §A2).
    if (balanceDue.greaterThan(0)) {
      await tx.customer.update({
        where: { id: customer.id },
        data: { balance: { increment: toAmountString(balanceDue) } },
      })
    }
    await tx.customer.update({ where: { id: customer.id }, data: { lastVisitAt: occurredAt } })

    // Same transaction as the sale, so an Intuit outage cannot fail a checkout
    // and a rolled-back checkout cannot leave a job behind (docs/08 §4).
    await enqueueIfConnected(tx, ctx.organizationId, {
      entityType: 'Sale',
      localId: sale.id,
      operation: 'CREATE',
    })
    if (amountPaid.greaterThan(0) && payment) {
      await enqueueIfConnected(tx, ctx.organizationId, {
        entityType: 'Payment',
        localId: payment.id,
        operation: 'CREATE',
      })
    }

    await writeAudit(tx, ctx, {
      action: 'sale.completed',
      entityType: 'Sale',
      entityId: sale.id,
      after: {
        saleNumber,
        customerName: customer.name,
        total: cart.total,
        lineCount: cart.lines.length,
      },
    })

    return {
      saleId: sale.id,
      saleNumber,
      receiptNumber,
      total: cart.total,
      amountPaid: toAmountString(amountPaid),
      balanceDue: toAmountString(balanceDue),
      replayed: false,
    }
  })
}

/**
 * Voiding (docs/02 §7). A compensating action, never a delete: stock goes back,
 * allocations unwind, the balance is restored, and the original stays readable.
 */
export async function voidSale(
  ctx: AuthContext,
  saleId: string,
  reason: string,
): Promise<void> {
  requirePermission(ctx, 'sale:void')
  const prisma = db(ctx)

  const sale = await prisma.sale.findFirst({
    where: { id: saleId },
    select: {
      id: true, saleNumber: true, status: true, customerId: true, balanceDue: true,
      total: true, inventoryTransactionId: true,
      items: { select: { productId: true, baseQuantity: true } },
      paymentAllocations: { select: { id: true, paymentId: true, amount: true } },
      transaction: { select: { lines: { select: { locationId: true, productId: true } } } },
    },
  })
  if (!sale) throw notFound('That sale')
  if (sale.status !== 'COMPLETED') throw conflict('Only a completed sale can be voided.')

  const locationByProduct = new Map(
    (sale.transaction?.lines ?? []).map((l) => [l.productId, l.locationId]),
  )

  await prisma.$transaction(async (tx) => {
    if (sale.inventoryTransactionId && locationByProduct.size > 0) {
      await postInventoryTransaction(tx, ctx.organizationId, {
        type: 'REVERSAL',
        createdByUserId: ctx.userId,
        referenceType: 'Sale',
        referenceId: sale.id,
        reversalOfId: sale.inventoryTransactionId,
        notes: `Void of ${sale.saleNumber}: ${reason}`,
        lines: sale.items
          .filter((item) => locationByProduct.has(item.productId))
          .map((item) => ({
            productId: item.productId,
            locationId: locationByProduct.get(item.productId)!,
            quantityDelta: item.baseQuantity,
          })),
      })
    }

    // Money that was applied to this sale returns to its payment as unapplied
    // credit rather than vanishing.
    for (const allocation of sale.paymentAllocations) {
      await tx.payment.update({
        where: { id: allocation.paymentId },
        data: { unappliedAmount: { increment: allocation.amount.toString() } },
      })
      await tx.paymentAllocation.update({
        where: { id: allocation.id },
        data: { amount: '0' },
      })
    }

    if (m(sale.balanceDue).greaterThan(0)) {
      await tx.customer.update({
        where: { id: sale.customerId },
        data: { balance: { decrement: sale.balanceDue.toString() } },
      })
    }

    await tx.sale.update({
      where: { id: sale.id },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason: reason,
        balanceDue: '0',
        amountPaid: '0',
      },
    })

    await writeAudit(tx, ctx, {
      action: 'sale.voided',
      entityType: 'Sale',
      entityId: sale.id,
      before: { saleNumber: sale.saleNumber, total: sale.total.toString() },
      after: { reason },
    })
  })
}

/** Where stock comes off: the runner's truck on a route, else the warehouse. */
export async function resolveSellingLocation(
  ctx: AuthContext,
): Promise<{ id: string; name: string }> {
  const prisma = db(ctx)

  const membership = await prisma.membership.findFirst({
    where: { userId: ctx.userId, status: 'ACTIVE' },
    select: { defaultVehicle: { select: { locationId: true, active: true, name: true } } },
  })

  if (membership?.defaultVehicle?.active) {
    return {
      id: membership.defaultVehicle.locationId,
      name: membership.defaultVehicle.name,
    }
  }

  const warehouse = await prisma.inventoryLocation.findFirst({
    where: { kind: 'WAREHOUSE', active: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  })
  if (!warehouse) throw conflict('There is nowhere to sell stock from yet.')
  return warehouse
}

/**
 * Prisma's Bytes column wants a Uint8Array backed by a plain ArrayBuffer; a Node
 * Buffer is a view over a shared pool and does not satisfy that type.
 */
function decodeDataUrl(dataUrl: string): Uint8Array<ArrayBuffer> {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
  const decoded = Buffer.from(base64, 'base64')
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength))
  bytes.set(decoded)
  return bytes
}

export type { Prisma }


/**
 * Open AR for one customer, used by the payment screen and the receipt.
 *
 * `payment:create` is enough here, deliberately: a runner who can take money at
 * the counter has to see what the money is for. It buys one store's invoices,
 * not the org-wide AR book, which still needs `payment:read`.
 */
export async function getOpenInvoices(ctx: AuthContext, customerId: string) {
  if (!can(ctx, 'payment:read')) requirePermission(ctx, 'payment:create')

  const sales = await db(ctx).sale.findMany({
    where: { customerId, status: 'COMPLETED', balanceDue: { gt: 0 } },
    orderBy: [{ dueDate: 'asc' }, { occurredAt: 'asc' }],
    select: {
      id: true, saleNumber: true, occurredAt: true, dueDate: true,
      total: true, balanceDue: true,
    },
  })

  return sales.map((sale) => ({
    saleId: sale.id,
    saleNumber: sale.saleNumber,
    occurredAt: sale.occurredAt.toISOString(),
    dueDate: (sale.dueDate ?? sale.occurredAt).toISOString(),
    total: toAmountString(sale.total),
    balanceDue: toAmountString(sale.balanceDue),
  }))
}

/**
 * The lines of an earlier sale, re-hydrated for "repeat last order".
 *
 * Products that have since been deactivated, or whose unit was retired, are
 * dropped rather than silently re-priced onto something else — a runner should
 * never discover at checkout that they are selling a different pack size.
 */
export async function getRepeatLines(ctx: AuthContext, saleId: string) {
  requirePermission(ctx, 'sale:create')
  const prisma = db(ctx)

  const sale = await prisma.sale.findFirst({
    where: { id: saleId },
    select: {
      items: {
        orderBy: { sortOrder: 'asc' },
        select: {
          productId: true,
          productUomId: true,
          quantity: true,
          product: {
            select: {
              id: true,
              name: true,
              active: true,
              uoms: {
                where: { active: true },
                orderBy: { sortOrder: 'asc' },
                select: {
                  id: true, code: true, label: true, baseUnitsPerUom: true,
                  price: true, isDefaultSaleUom: true,
                },
              },
            },
          },
        },
      },
    },
  })
  if (!sale) throw notFound('That order')

  return sale.items
    .filter((item) => item.product.active && item.product.uoms.some((u) => u.id === item.productUomId))
    .map((item) => ({
      productId: item.productId,
      productUomId: item.productUomId,
      quantity: item.quantity,
      name: item.product.name,
      uoms: item.product.uoms.map((uom) => ({
        id: uom.id,
        code: uom.code,
        label: uom.label,
        baseUnitsPerUom: uom.baseUnitsPerUom,
        price: toAmountString(uom.price),
        isDefaultSaleUom: uom.isDefaultSaleUom,
      })),
    }))
}

/**
 * The receipt book (spec §25).
 *
 * Filters by store, date range, payment state and amount, and searches receipt
 * numbers and store names. Everything narrows the `where` clause: a runner
 * without the org-wide `sale:read` gets `soldByUserId` added to the query, not
 * a filter applied to rows already fetched (docs/04 §3).
 */
export async function listSales(ctx: AuthContext, query: Partial<ReceiptQuery> = {}) {
  if (!can(ctx, 'sale:read') && !can(ctx, 'sale:read_own')) {
    requirePermission(ctx, 'sale:read')
  }

  const prisma = db(ctx)
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25))
  const search = query.search?.trim()

  const where: Prisma.SaleWhereInput = {
    ...(can(ctx, 'sale:read') ? {} : { soldByUserId: ctx.userId }),
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...occurredBetween(query.from, query.to, ctx.organization.timezone),
    ...amountBetween(query.minAmount, query.maxAmount),
    ...paymentState(query.status ?? 'all'),
    ...(search
      ? {
          OR: [
            { saleNumber: { contains: search, mode: 'insensitive' } },
            { receipt: { receiptNumber: { contains: search, mode: 'insensitive' } } },
            { customer: { name: { contains: search, mode: 'insensitive' } } },
            { customer: { accountNumber: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }

  const [rows, total, totals] = await Promise.all([
    prisma.sale.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, saleNumber: true, status: true, occurredAt: true, dueDate: true,
        total: true, balanceDue: true,
        customer: { select: { id: true, name: true } },
        soldBy: { select: { firstName: true, lastName: true } },
        receipt: { select: { receiptNumber: true, emailedAt: true, textedAt: true } },
      },
    }),
    prisma.sale.count({ where }),
    // Summed over the whole filtered set, not the page: "what did this store
    // buy in August" is the question a filter is usually asking.
    prisma.sale.aggregate({ where, _sum: { total: true, balanceDue: true } }),
  ])

  return {
    items: rows.map((sale) => ({
      id: sale.id,
      saleNumber: sale.saleNumber,
      receiptNumber: sale.receipt?.receiptNumber ?? sale.saleNumber,
      status: sale.status,
      occurredAt: sale.occurredAt.toISOString(),
      dueDate: sale.dueDate?.toISOString() ?? null,
      customerId: sale.customer.id,
      customerName: sale.customer.name,
      soldByName: `${sale.soldBy.firstName} ${sale.soldBy.lastName}`.trim(),
      total: toAmountString(sale.total),
      balanceDue: toAmountString(sale.balanceDue),
      delivered: Boolean(sale.receipt?.emailedAt || sale.receipt?.textedAt),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    sumTotal: toAmountString(totals._sum.total ?? 0),
    sumBalanceDue: toAmountString(totals._sum.balanceDue ?? 0),
  }
}

export type SaleListItem = Awaited<ReturnType<typeof listSales>>['items'][number]

/** Calendar days in the company's zone, not the server's. */
function occurredBetween(
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
): Prisma.SaleWhereInput {
  if (!from && !to) return {}
  return {
    occurredAt: {
      ...(from ? { gte: startOfDayInZone(dateOnly(from), timeZone) } : {}),
      ...(to ? { lte: endOfDayInZone(dateOnly(to), timeZone) } : {}),
    },
  }
}

function amountBetween(min: string | undefined, max: string | undefined): Prisma.SaleWhereInput {
  if (!min && !max) return {}
  return {
    total: {
      ...(min ? { gte: min } : {}),
      ...(max ? { lte: max } : {}),
    },
  }
}

function paymentState(status: ReceiptQuery['status']): Prisma.SaleWhereInput {
  switch (status) {
    case 'paid':
      return { status: 'COMPLETED', balanceDue: { lte: 0 } }
    case 'open':
      return { status: 'COMPLETED', balanceDue: { gt: 0 } }
    case 'overdue':
      // A due date in the past with money still on it. Sales with no due date
      // are COD and are never "overdue" — they were due at the counter.
      return { status: 'COMPLETED', balanceDue: { gt: 0 }, dueDate: { lt: new Date() } }
    case 'voided':
      return { status: 'VOIDED' }
    default:
      return {}
  }
}

export { allocateOldestFirst }
