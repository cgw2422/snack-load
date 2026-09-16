import { Prisma } from '@/generated/prisma/client'
import { db, type TenantTx } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'
import { m, round2, round6, toAmountString } from '@/server/domain/money'
import { toBaseUnits } from '@/server/domain/uom'
import { nextDocumentNumber, postInventoryTransaction } from './inventory.service'
import { writeAudit } from './audit.service'
import type { AdjustmentInput, ReceivingInput, TransferInput } from '@/lib/schemas/inventory'

/**
 * Stock coming in, moving between locations, and being written off.
 *
 * Everything here is a thin orchestration over the ledger engine: resolve UoMs
 * to base units, post one transaction, write the audit row, all in a single
 * database transaction so stock and its explanation commit together.
 */

export type PostedResult = {
  id: string
  reference: string
  /** True when a retry hit the idempotency key and the original was returned. */
  replayed: boolean
}

type ResolvedLine = {
  productId: string
  productUomId: string
  quantity: number
  baseQuantity: number
  productName: string
  uomLabel: string
  baseUnitsPerUom: number
}

/** Receiving a supplier shipment (spec §18). */
export async function receiveStock(
  ctx: AuthContext,
  input: ReceivingInput,
): Promise<PostedResult> {
  requirePermission(ctx, 'inventory:receive')
  const prisma = db(ctx)

  const replay = await prisma.receiving.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, referenceNumber: true },
  })
  if (replay) {
    return { id: replay.id, reference: replay.referenceNumber ?? '', replayed: true }
  }

  await assertLocationKind(ctx, input.warehouseLocationId, 'WAREHOUSE')
  const lines = await resolveLines(ctx, input.lines)

  return prisma.$transaction(async (tx) => {
    const reference =
      input.referenceNumber || (await nextDocumentNumber(tx, ctx.organizationId, 'RECEIVING'))
    const occurredAt = input.receivedAt ? new Date(input.receivedAt) : new Date()

    const posted = await postInventoryTransaction(tx, ctx.organizationId, {
      type: 'SUPPLIER_RECEIPT',
      occurredAt,
      createdByUserId: ctx.userId,
      referenceType: 'Receiving',
      notes: input.notes || undefined,
      idempotencyKey: input.idempotencyKey,
      lines: lines.map((line, i) => ({
        productId: line.productId,
        locationId: input.warehouseLocationId,
        quantityDelta: line.baseQuantity,
        // The invoice prices a case; the ledger costs a base unit.
        unitCost: round6(
          m(input.lines[i].unitCost).dividedBy(line.baseUnitsPerUom),
        ).toString(),
      })),
    })

    const receiving = await tx.receiving.create({
      data: {
        organizationId: ctx.organizationId,
        supplierId: input.supplierId || null,
        warehouseLocationId: input.warehouseLocationId,
        referenceNumber: reference,
        receivedAt: occurredAt,
        receivedByUserId: ctx.userId,
        notes: input.notes || undefined,
        inventoryTransactionId: posted.transactionId,
        idempotencyKey: input.idempotencyKey,
        items: {
          create: lines.map((line, i) => ({
            organizationId: ctx.organizationId,
            productId: line.productId,
            productUomId: line.productUomId,
            quantity: line.quantity,
            baseQuantity: line.baseQuantity,
            unitCost: round6(
              m(input.lines[i].unitCost).dividedBy(line.baseUnitsPerUom),
            ).toString(),
            lineCost: round2(m(input.lines[i].unitCost).times(line.quantity)).toString(),
          })),
        },
      },
      select: { id: true },
    })

    await tx.inventoryTransaction.update({
      where: { id: posted.transactionId },
      data: { referenceId: receiving.id },
    })

    await writeAudit(tx, ctx, {
      action: 'inventory.received',
      entityType: 'Receiving',
      entityId: receiving.id,
      after: {
        reference,
        lineCount: lines.length,
        totalCost: toAmountString(
          lines.reduce(
            (sum, line, i) => sum.plus(m(input.lines[i].unitCost).times(line.quantity)),
            m(0),
          ),
        ),
      },
    })

    return { id: receiving.id, reference, replayed: false }
  })
}

/**
 * Adjustments (spec §17). A physical count sets the balance; every other reason
 * removes stock. Either way the ledger records who, when and why.
 */
export async function adjustStock(
  ctx: AuthContext,
  input: AdjustmentInput,
): Promise<PostedResult> {
  requirePermission(ctx, 'inventory:adjust')
  const prisma = db(ctx)

  const replay = await prisma.inventoryTransaction.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (replay) return { id: replay.id, reference: '', replayed: true }

  const lines = await resolveLines(ctx, input.lines, { allowNegative: true })
  const isCount = input.type === 'COUNT_ADJUSTMENT'

  // A count states what is on the shelf; the delta is the difference from what
  // we believed. Everything else states the delta directly.
  const currentBalances = isCount
    ? new Map(
        (
          await prisma.inventoryBalance.findMany({
            where: {
              locationId: input.locationId,
              productId: { in: lines.map((l) => l.productId) },
            },
            select: { productId: true, quantity: true },
          })
        ).map((b) => [b.productId, b.quantity]),
      )
    : new Map<string, number>()

  const deltas = lines
    .map((line) => ({
      line,
      delta: isCount
        ? line.baseQuantity - (currentBalances.get(line.productId) ?? 0)
        : // Outward reasons are entered as a positive count of what was lost.
          OUTWARD.has(input.type)
          ? -Math.abs(line.baseQuantity)
          : line.baseQuantity,
    }))
    .filter((entry) => entry.delta !== 0)

  if (deltas.length === 0) {
    throw conflict('Nothing to adjust — the counts already match what we have.')
  }

  return prisma.$transaction(async (tx) => {
    const posted = await postInventoryTransaction(tx, ctx.organizationId, {
      type: input.type,
      createdByUserId: ctx.userId,
      reasonCode: input.type,
      notes: input.notes,
      idempotencyKey: input.idempotencyKey,
      // A count is the one movement allowed to produce any value, including a
      // negative one — that is the point of counting (docs/02 §L4).
      allowNegative: isCount,
      lines: deltas.map(({ line, delta }) => ({
        productId: line.productId,
        locationId: input.locationId,
        quantityDelta: delta,
      })),
    })

    await writeAudit(tx, ctx, {
      action: `inventory.${input.type.toLowerCase()}`,
      entityType: 'InventoryTransaction',
      entityId: posted.transactionId,
      after: {
        reason: input.type,
        notes: input.notes,
        lines: deltas.map(({ line, delta }) => ({
          product: line.productName,
          baseUnits: delta,
        })),
      },
    })

    return { id: posted.transactionId, reference: '', replayed: false }
  })
}

const OUTWARD: ReadonlySet<string> = new Set(['DAMAGE', 'EXPIRED', 'MISSING', 'SAMPLE'])

/** Warehouse to warehouse. Truck movements go through truckload.service. */
export async function transferStock(
  ctx: AuthContext,
  input: TransferInput,
): Promise<PostedResult> {
  requirePermission(ctx, 'inventory:transfer')
  const prisma = db(ctx)

  if (input.fromLocationId === input.toLocationId) {
    throw conflict('Choose two different locations.')
  }

  const replay = await prisma.inventoryTransaction.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (replay) return { id: replay.id, reference: '', replayed: true }

  const lines = await resolveLines(ctx, input.lines)

  return prisma.$transaction(async (tx) => {
    const posted = await postInventoryTransaction(tx, ctx.organizationId, {
      type: 'TRANSFER',
      createdByUserId: ctx.userId,
      notes: input.notes || undefined,
      idempotencyKey: input.idempotencyKey,
      // Two mirrored lines per product: the engine asserts they net to zero.
      lines: lines.flatMap((line) => [
        {
          productId: line.productId,
          locationId: input.fromLocationId,
          quantityDelta: -line.baseQuantity,
        },
        {
          productId: line.productId,
          locationId: input.toLocationId,
          quantityDelta: line.baseQuantity,
        },
      ]),
    })

    await writeAudit(tx, ctx, {
      action: 'inventory.transferred',
      entityType: 'InventoryTransaction',
      entityId: posted.transactionId,
      after: {
        from: input.fromLocationId,
        to: input.toLocationId,
        lines: lines.map((l) => ({ product: l.productName, baseUnits: l.baseQuantity })),
      },
    })

    return { id: posted.transactionId, reference: '', replayed: false }
  })
}

// ── shared helpers ───────────────────────────────────────────────────────────

/**
 * Turns (product, UoM, quantity) into base units, checking that each UoM really
 * belongs to its product. Without that check a crafted payload could price a
 * bag of Takis as a case.
 */
export async function resolveLines(
  ctx: AuthContext,
  lines: { productId: string; productUomId: string; quantity: number }[],
  options: { allowNegative?: boolean } = {},
): Promise<ResolvedLine[]> {
  const uomIds = [...new Set(lines.map((l) => l.productUomId))]

  const uoms = await db(ctx).productUom.findMany({
    where: { id: { in: uomIds } },
    select: {
      id: true,
      label: true,
      baseUnitsPerUom: true,
      productId: true,
      product: { select: { id: true, name: true, active: true } },
    },
  })
  const byId = new Map(uoms.map((u) => [u.id, u]))

  return lines.map((line) => {
    const uom = byId.get(line.productUomId)
    if (!uom) throw notFound('That unit of measure')
    if (uom.productId !== line.productId) {
      throw conflict(`"${uom.label}" does not belong to ${uom.product.name}.`)
    }
    if (!options.allowNegative && line.quantity <= 0) {
      throw conflict(`Enter how many ${uom.label.toLowerCase()}s of ${uom.product.name}.`)
    }

    return {
      productId: line.productId,
      productUomId: line.productUomId,
      quantity: line.quantity,
      baseQuantity: toBaseUnits(line.quantity, uom.baseUnitsPerUom),
      productName: uom.product.name,
      uomLabel: uom.label,
      baseUnitsPerUom: uom.baseUnitsPerUom,
    }
  })
}

export async function assertLocationKind(
  ctx: AuthContext,
  locationId: string,
  kind: 'WAREHOUSE' | 'VEHICLE',
): Promise<void> {
  const location = await db(ctx).inventoryLocation.findFirst({
    where: { id: locationId },
    select: { kind: true, active: true, name: true },
  })
  if (!location) throw notFound('That location')
  if (!location.active) throw conflict(`${location.name} is no longer in use.`)
  if (location.kind !== kind) {
    throw conflict(
      kind === 'WAREHOUSE'
        ? `${location.name} is a truck, not a warehouse.`
        : `${location.name} is a warehouse, not a truck.`,
    )
  }
}

/** Movement history for a product, a location, or the whole company. */
export async function listLedger(
  ctx: AuthContext,
  filter: { productId?: string; locationId?: string; limit?: number },
) {
  requirePermission(ctx, 'inventory:read')

  const lines = await db(ctx).inventoryTransactionLine.findMany({
    where: {
      ...(filter.productId ? { productId: filter.productId } : {}),
      ...(filter.locationId ? { locationId: filter.locationId } : {}),
    },
    orderBy: { transaction: { occurredAt: 'desc' } },
    take: filter.limit ?? 50,
    select: {
      id: true,
      quantityDelta: true,
      balanceAfter: true,
      unitCost: true,
      product: {
        select: {
          id: true, name: true, sku: true, baseUomLabel: true,
          uoms: { where: { isBase: false, active: true }, take: 1, select: { baseUnitsPerUom: true } },
        },
      },
      location: { select: { id: true, name: true, kind: true } },
      transaction: {
        select: {
          id: true, type: true, occurredAt: true, notes: true, reasonCode: true,
          createdBy: { select: { firstName: true, lastName: true } },
        },
      },
    },
  })

  return lines.map((line) => ({
    id: line.id,
    type: line.transaction.type,
    occurredAt: line.transaction.occurredAt.toISOString(),
    notes: line.transaction.notes,
    actorName: line.transaction.createdBy
      ? `${line.transaction.createdBy.firstName} ${line.transaction.createdBy.lastName}`.trim()
      : null,
    productId: line.product.id,
    productName: line.product.name,
    sku: line.product.sku,
    baseUomLabel: line.product.baseUomLabel,
    unitsPerCase: line.product.uoms[0]?.baseUnitsPerUom ?? 1,
    locationId: line.location.id,
    locationName: line.location.name,
    locationKind: line.location.kind,
    quantityDelta: line.quantityDelta,
    balanceAfter: line.balanceAfter,
  }))
}

export type LedgerEntry = Awaited<ReturnType<typeof listLedger>>[number]

/** Used by the transfer and adjustment screens to show what is actually there. */
export async function getLocationStock(ctx: AuthContext, locationId: string) {
  requirePermission(ctx, 'inventory:read')

  const balances = await db(ctx).inventoryBalance.findMany({
    where: { locationId, quantity: { not: 0 } },
    orderBy: { product: { name: 'asc' } },
    select: {
      quantity: true,
      avgUnitCost: true,
      product: {
        select: {
          id: true, name: true, sku: true, baseUomLabel: true,
          uoms: {
            where: { active: true },
            orderBy: { baseUnitsPerUom: 'asc' },
            select: { id: true, label: true, baseUnitsPerUom: true, isDefaultSaleUom: true },
          },
        },
      },
    },
  })

  return balances.map((balance) => ({
    productId: balance.product.id,
    name: balance.product.name,
    sku: balance.product.sku,
    baseUomLabel: balance.product.baseUomLabel,
    quantity: balance.quantity,
    unitsPerCase:
      balance.product.uoms.find((u) => u.baseUnitsPerUom > 1)?.baseUnitsPerUom ?? 1,
    uoms: balance.product.uoms,
    value: toAmountString(m(balance.avgUnitCost).times(balance.quantity)),
  }))
}

export type LocationStock = Awaited<ReturnType<typeof getLocationStock>>[number]

/** Kept for services that need a transaction-bound variant later. */
export type InventoryTx = TenantTx
export type { Prisma }
