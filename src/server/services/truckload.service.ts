import { Prisma } from '@/generated/prisma/client'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'
import { toAmountString } from '@/server/domain/money'
import { formatQuantity } from '@/server/domain/uom'
import { nextDocumentNumber, postInventoryTransaction } from './inventory.service'
import { assertLocationKind, resolveLines, type PostedResult } from './receiving.service'
import { writeAudit } from './audit.service'
import type { TruckLoadInput, VehicleInput } from '@/lib/schemas/inventory'

/**
 * Loading and unloading trucks (spec §19, §20).
 *
 * A load is a transfer between two inventory locations, so the ledger engine
 * already enforces that nothing is created along the way. What lives here is the
 * operational layer: which truck, which route, and what to suggest loading.
 */

export async function moveTruckStock(
  ctx: AuthContext,
  input: TruckLoadInput,
): Promise<PostedResult> {
  requirePermission(
    ctx,
    input.direction === 'LOAD' ? 'inventory:load_truck' : 'inventory:unload_truck',
  )
  const prisma = db(ctx)

  const replay = await prisma.truckLoad.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  })
  if (replay) return { id: replay.id, reference: '', replayed: true }

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: input.vehicleId },
    select: { id: true, name: true, truckNumber: true, locationId: true, active: true, assignedUserId: true },
  })
  if (!vehicle) throw notFound('That truck')
  if (!vehicle.active) throw conflict(`${vehicle.name} is no longer in service.`)

  await assertLocationKind(ctx, input.warehouseLocationId, 'WAREHOUSE')
  const lines = await resolveLines(ctx, input.lines)

  const loading = input.direction === 'LOAD'
  const source = loading ? input.warehouseLocationId : vehicle.locationId
  const destination = loading ? vehicle.locationId : input.warehouseLocationId

  return prisma.$transaction(async (tx) => {
    const reference = await nextDocumentNumber(tx, ctx.organizationId, 'TRUCK_LOAD')

    const posted = await postInventoryTransaction(tx, ctx.organizationId, {
      type: loading ? 'TRUCK_LOAD' : 'TRUCK_UNLOAD',
      createdByUserId: ctx.userId,
      referenceType: 'TruckLoad',
      notes: input.notes || undefined,
      idempotencyKey: input.idempotencyKey,
      lines: lines.flatMap((line) => [
        { productId: line.productId, locationId: source, quantityDelta: -line.baseQuantity },
        { productId: line.productId, locationId: destination, quantityDelta: line.baseQuantity },
      ]),
    })

    const truckLoad = await tx.truckLoad.create({
      data: {
        organizationId: ctx.organizationId,
        vehicleId: vehicle.id,
        routeId: input.routeId || null,
        runnerUserId: vehicle.assignedUserId,
        direction: input.direction,
        status: 'CONFIRMED',
        warehouseLocationId: input.warehouseLocationId,
        loadedAt: new Date(),
        createdByUserId: ctx.userId,
        notes: input.notes || null,
        inventoryTransactionId: posted.transactionId,
        idempotencyKey: input.idempotencyKey,
        items: {
          create: lines.map((line) => ({
            organizationId: ctx.organizationId,
            productId: line.productId,
            productUomId: line.productUomId,
            quantity: line.quantity,
            baseQuantity: line.baseQuantity,
          })),
        },
      },
      select: { id: true },
    })

    await tx.inventoryTransaction.update({
      where: { id: posted.transactionId },
      data: { referenceId: truckLoad.id },
    })

    await writeAudit(tx, ctx, {
      action: loading ? 'truckload.confirmed' : 'truckload.unloaded',
      entityType: 'TruckLoad',
      entityId: truckLoad.id,
      after: {
        reference,
        truckNumber: vehicle.truckNumber,
        lineCount: lines.length,
        lines: lines.map((l) => ({ product: l.productName, baseUnits: l.baseQuantity })),
      },
    })

    return { id: truckLoad.id, reference, replayed: false }
  })
}

export type SuggestedLoadLine = {
  productId: string
  name: string
  sku: string
  productUomId: string
  uomLabel: string
  baseUnitsPerUom: number
  /** Suggested quantity, in the suggested UoM. */
  suggestedQuantity: number
  onTruck: number
  onTruckLabel: string
  availableAtWarehouse: number
  availableLabel: string
  /** Why this quantity, in words the person loading can check. */
  rationale: string
}

/**
 * Suggested load (spec §19).
 *
 * Built from what these stores actually bought on this route over the last eight
 * weeks, less what is already on the truck, capped by what the warehouse has.
 * The history window is deliberately short: a snack route's mix changes with the
 * season, and a year of data would keep suggesting last winter's hot chocolate.
 *
 * It is a suggestion. Everything is editable before anything is posted.
 */
export async function suggestLoad(
  ctx: AuthContext,
  args: { vehicleId: string; routeTemplateId?: string; warehouseLocationId: string },
): Promise<SuggestedLoadLine[]> {
  requirePermission(ctx, 'inventory:load_truck')
  const prisma = db(ctx)

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: args.vehicleId },
    select: { locationId: true },
  })
  if (!vehicle) throw notFound('That truck')

  const since = new Date()
  since.setUTCDate(since.getUTCDate() - 56)

  // Average sold per run, by product, for the stores this route serves.
  const history = await prisma.$queryRaw<
    { product_id: string; base_units: string; runs: string }[]
  >(Prisma.sql`
    SELECT si.product_id,
           SUM(si.base_quantity)::text                AS base_units,
           COUNT(DISTINCT s.route_id)::text           AS runs
      FROM sale_item si
      JOIN sale s ON s.id = si.sale_id
      ${
        args.routeTemplateId
          ? Prisma.sql`JOIN route r ON r.id = s.route_id AND r.route_template_id = ${args.routeTemplateId}`
          : Prisma.sql`JOIN route r ON r.id = s.route_id`
      }
     WHERE si.organization_id = ${ctx.organizationId}
       AND s.status = 'COMPLETED'
       AND s.occurred_at >= ${since}
     GROUP BY si.product_id
     HAVING SUM(si.base_quantity) > 0
     ORDER BY SUM(si.base_quantity) DESC
     LIMIT 60
  `)

  if (history.length === 0) return []

  const productIds = history.map((h) => h.product_id)

  const [products, truckStock, warehouseStock] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds }, active: true },
      select: {
        id: true,
        name: true,
        sku: true,
        baseUomLabel: true,
        uoms: {
          where: { active: true },
          orderBy: { baseUnitsPerUom: 'desc' },
          select: { id: true, label: true, baseUnitsPerUom: true },
        },
      },
    }),
    prisma.inventoryBalance.findMany({
      where: { locationId: vehicle.locationId, productId: { in: productIds } },
      select: { productId: true, quantity: true },
    }),
    prisma.inventoryBalance.findMany({
      where: { locationId: args.warehouseLocationId, productId: { in: productIds } },
      select: { productId: true, quantity: true },
    }),
  ])

  const onTruck = new Map(truckStock.map((b) => [b.productId, b.quantity]))
  const atWarehouse = new Map(warehouseStock.map((b) => [b.productId, b.quantity]))
  const byId = new Map(products.map((p) => [p.id, p]))

  const suggestions: SuggestedLoadLine[] = []

  for (const row of history) {
    const product = byId.get(row.product_id)
    if (!product) continue

    // Largest packaging first: a runner loads cases, not individual bags.
    const uom = product.uoms[0]
    if (!uom) continue

    const runs = Math.max(1, Number(row.runs))
    const averagePerRun = Number(row.base_units) / runs

    // A fifth over the average absorbs a good week without burying the truck.
    const target = Math.ceil(averagePerRun * 1.2)
    const already = onTruck.get(product.id) ?? 0
    const available = atWarehouse.get(product.id) ?? 0

    const needed = Math.max(0, target - already)
    const suggestedBase = Math.min(needed, available)
    const suggestedQuantity = Math.floor(suggestedBase / uom.baseUnitsPerUom)

    if (suggestedQuantity <= 0) continue

    // "6 bx 24 ea" rather than "6 cs 24 ea": a product sold by the box should
    // not be described in cases.
    const labels = {
      package: uom.label.slice(0, 2).toLowerCase(),
      unit: product.baseUomLabel.slice(0, 2).toLowerCase(),
    }
    const describe = (baseUnits: number) =>
      formatQuantity(baseUnits, uom.baseUnitsPerUom, labels)

    suggestions.push({
      productId: product.id,
      name: product.name,
      sku: product.sku,
      productUomId: uom.id,
      uomLabel: uom.label,
      baseUnitsPerUom: uom.baseUnitsPerUom,
      suggestedQuantity,
      onTruck: already,
      onTruckLabel: describe(already),
      availableAtWarehouse: available,
      availableLabel: describe(available),
      rationale:
        already > 0
          ? `Sells about ${describe(Math.round(averagePerRun))} a run; ${describe(already)} already aboard`
          : `Sells about ${describe(Math.round(averagePerRun))} a run`,
    })
  }

  return suggestions
}

export async function listVehicles(ctx: AuthContext) {
  requirePermission(ctx, 'inventory:read')

  const vehicles = await db(ctx).vehicle.findMany({
    orderBy: [{ active: 'desc' }, { truckNumber: 'asc' }],
    select: {
      id: true,
      name: true,
      truckNumber: true,
      licensePlate: true,
      active: true,
      notes: true,
      locationId: true,
      assignedUser: { select: { id: true, firstName: true, lastName: true } },
      location: {
        select: {
          balances: { where: { quantity: { not: 0 } }, select: { quantity: true, avgUnitCost: true } },
        },
      },
    },
  })

  return vehicles.map((vehicle) => {
    const value = vehicle.location.balances.reduce(
      (sum, b) => sum + Number(b.avgUnitCost) * b.quantity,
      0,
    )
    return {
      id: vehicle.id,
      name: vehicle.name,
      truckNumber: vehicle.truckNumber,
      licensePlate: vehicle.licensePlate,
      active: vehicle.active,
      notes: vehicle.notes,
      locationId: vehicle.locationId,
      runnerId: vehicle.assignedUser?.id ?? null,
      runnerName: vehicle.assignedUser
        ? `${vehicle.assignedUser.firstName} ${vehicle.assignedUser.lastName}`.trim()
        : null,
      skuCount: vehicle.location.balances.length,
      stockValue: toAmountString(value.toFixed(6)),
    }
  })
}

export type VehicleListItem = Awaited<ReturnType<typeof listVehicles>>[number]

export async function createVehicle(ctx: AuthContext, input: VehicleInput) {
  requirePermission(ctx, 'inventory:transfer')
  const prisma = db(ctx)

  const clash = await prisma.vehicle.findFirst({
    where: { truckNumber: input.truckNumber },
    select: { name: true },
  })
  if (clash) throw conflict(`Truck number ${input.truckNumber} is already used by ${clash.name}.`)

  return prisma.$transaction(async (tx) => {
    // Every stock-holding thing is an InventoryLocation (docs/01 §D1), so a new
    // truck gets one before it can hold anything.
    const location = await tx.inventoryLocation.create({
      data: {
        organizationId: ctx.organizationId,
        kind: 'VEHICLE',
        name: input.name,
        code: `T${input.truckNumber}`,
      },
      select: { id: true },
    })

    const vehicle = await tx.vehicle.create({
      data: {
        organizationId: ctx.organizationId,
        locationId: location.id,
        name: input.name,
        truckNumber: input.truckNumber,
        licensePlate: input.licensePlate || null,
        assignedUserId: input.assignedUserId || null,
        active: input.active,
        notes: input.notes || null,
      },
      select: { id: true },
    })

    await writeAudit(tx, ctx, {
      action: 'vehicle.created',
      entityType: 'Vehicle',
      entityId: vehicle.id,
      after: { name: input.name, truckNumber: input.truckNumber },
    })

    return { id: vehicle.id }
  })
}

export async function updateVehicle(ctx: AuthContext, id: string, input: VehicleInput) {
  requirePermission(ctx, 'inventory:transfer')
  const prisma = db(ctx)

  const existing = await prisma.vehicle.findFirst({
    where: { id },
    select: { id: true, locationId: true, name: true, truckNumber: true, active: true },
  })
  if (!existing) throw notFound('That truck')

  const clash = await prisma.vehicle.findFirst({
    where: { truckNumber: input.truckNumber, NOT: { id } },
    select: { name: true },
  })
  if (clash) throw conflict(`Truck number ${input.truckNumber} is already used by ${clash.name}.`)

  await prisma.$transaction(async (tx) => {
    await tx.vehicle.update({
      where: { id },
      data: {
        name: input.name,
        truckNumber: input.truckNumber,
        licensePlate: input.licensePlate || null,
        assignedUserId: input.assignedUserId || null,
        active: input.active,
        notes: input.notes || null,
      },
    })
    // The location carries the truck's name in every ledger row, so keep it in step.
    await tx.inventoryLocation.update({
      where: { id: existing.locationId },
      data: { name: input.name, code: `T${input.truckNumber}`, active: input.active },
    })

    await writeAudit(tx, ctx, {
      action: 'vehicle.updated',
      entityType: 'Vehicle',
      entityId: id,
      before: { name: existing.name, truckNumber: existing.truckNumber, active: existing.active },
      after: { name: input.name, truckNumber: input.truckNumber, active: input.active },
    })
  })
}
