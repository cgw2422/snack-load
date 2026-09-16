import { Prisma } from '@/generated/prisma/client'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'
import { toAmountString, toCostString } from '@/server/domain/money'
import { formatQuantity } from '@/server/domain/uom'
import type { ListQuery, ProductInput } from '@/lib/schemas/catalog'
import { changedFields, writeAudit } from './audit.service'

/** The product catalog: what a distributor buys, stocks and sells. */

export type ProductUomDto = {
  id: string
  code: string
  label: string
  baseUnitsPerUom: number
  price: string
  barcode: string | null
  isBase: boolean
  isDefaultSaleUom: boolean
}

export type ProductListItem = {
  id: string
  sku: string
  upc: string | null
  name: string
  brand: string | null
  categoryName: string | null
  supplierName: string | null
  active: boolean
  taxable: boolean
  baseUomLabel: string
  unitsPerCase: number
  casePrice: string | null
  unitPrice: string
  costPerBaseUnit: string
  onHandBaseUnits: number
  onHandLabel: string
  reorderPointBaseUnits: number
  belowReorderPoint: boolean
}

export type ProductDetail = ProductListItem & {
  description: string | null
  notes: string | null
  weightGrams: number | null
  categoryId: string | null
  supplierId: string | null
  uoms: ProductUomDto[]
  stockByLocation: { locationId: string; locationName: string; kind: string; quantity: number; label: string }[]
}

export type Paged<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

const SORTS: Record<string, Prisma.ProductOrderByWithRelationInput[]> = {
  name: [{ name: 'asc' }],
  sku: [{ sku: 'asc' }],
  newest: [{ createdAt: 'desc' }],
  cost: [{ costPerBaseUnit: 'desc' }],
}

export async function listProducts(
  ctx: AuthContext,
  query: ListQuery,
): Promise<Paged<ProductListItem>> {
  requirePermission(ctx, 'product:read')
  const prisma = db(ctx)

  const where: Prisma.ProductWhereInput = {
    ...(query.status === 'all' ? {} : { active: query.status === 'active' }),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { sku: { contains: query.search, mode: 'insensitive' } },
            { upc: { contains: query.search, mode: 'insensitive' } },
            { brand: { contains: query.search, mode: 'insensitive' } },
            // A scanned barcode is often on the case, not the product row.
            { uoms: { some: { barcode: { equals: query.search } } } },
          ],
        }
      : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: SORTS[query.sort ?? 'name'] ?? SORTS.name,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: productListSelect,
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

export async function getProduct(ctx: AuthContext, id: string): Promise<ProductDetail> {
  requirePermission(ctx, 'product:read')

  const product = await db(ctx).product.findFirst({
    where: { id },
    select: {
      ...productListSelect,
      description: true,
      notes: true,
      weightGrams: true,
      categoryId: true,
      supplierId: true,
      balances: {
        select: {
          quantity: true,
          location: { select: { id: true, name: true, kind: true } },
        },
        orderBy: { location: { name: 'asc' } },
      },
    },
  })
  if (!product) throw notFound('Product')

  const base = toListItem(product)

  return {
    ...base,
    description: product.description,
    notes: product.notes,
    weightGrams: product.weightGrams,
    categoryId: product.categoryId,
    supplierId: product.supplierId,
    uoms: product.uoms.map(toUomDto),
    stockByLocation: product.balances.map((b) => ({
      locationId: b.location.id,
      locationName: b.location.name,
      kind: b.location.kind,
      quantity: b.quantity,
      label: formatQuantity(b.quantity, base.unitsPerCase),
    })),
  }
}

export async function createProduct(ctx: AuthContext, input: ProductInput): Promise<{ id: string }> {
  requirePermission(ctx, 'product:create')
  const prisma = db(ctx)

  await assertSkuAndUpcFree(ctx, input.sku, input.upc || null, null)
  assertUomSetIsCoherent(input)

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        organizationId: ctx.organizationId,
        ...scalarFields(input),
        uoms: {
          create: input.uoms.map((uom) => ({
            organizationId: ctx.organizationId,
            ...uomFlags(input.uoms)(uom),
          })),
        },
      },
      select: { id: true, sku: true, name: true },
    })

    await writeAudit(tx, ctx, {
      action: 'product.created',
      entityType: 'Product',
      entityId: product.id,
      after: { sku: product.sku, name: product.name },
    })

    return { id: product.id }
  })
}

export async function updateProduct(
  ctx: AuthContext,
  id: string,
  input: ProductInput,
): Promise<void> {
  requirePermission(ctx, 'product:update')
  const prisma = db(ctx)

  const existing = await prisma.product.findFirst({
    where: { id },
    select: { ...productListSelect, categoryId: true, supplierId: true },
  })
  if (!existing) throw notFound('Product')

  await assertSkuAndUpcFree(ctx, input.sku, input.upc || null, id)
  assertUomSetIsCoherent(input)

  await prisma.$transaction(async (tx) => {
    const next = scalarFields(input)
    await tx.product.update({ where: { id }, data: next })

    // UoMs are reconciled, never deleted: a sale line points at a UoM row, and
    // removing one would orphan a receipt that has already been printed. A unit
    // the user dropped is deactivated; one they re-add is revived by its code.
    const flags = uomFlags(input.uoms)
    const keptCodes = new Set(input.uoms.map((u) => u.code))

    for (const uom of existing.uoms) {
      if (!keptCodes.has(uom.code)) {
        await tx.productUom.update({ where: { id: uom.id }, data: { active: false } })
      }
    }

    for (const uom of input.uoms) {
      await tx.productUom.upsert({
        where: { productId_code: { productId: id, code: uom.code } },
        create: { organizationId: ctx.organizationId, productId: id, ...flags(uom) },
        update: flags(uom),
      })
    }

    const diff = changedFields(
      { ...existing, costPerBaseUnit: existing.costPerBaseUnit.toString() },
      next as Record<string, unknown>,
    )
    if (Object.keys(diff.after).length > 0) {
      await writeAudit(tx, ctx, {
        action: 'product.updated',
        entityType: 'Product',
        entityId: id,
        before: diff.before,
        after: diff.after,
      })
    }
  })
}

export async function setProductActive(
  ctx: AuthContext,
  id: string,
  active: boolean,
): Promise<void> {
  requirePermission(ctx, active ? 'product:update' : 'product:deactivate')
  const prisma = db(ctx)

  const existing = await prisma.product.findFirst({ where: { id }, select: { active: true } })
  if (!existing) throw notFound('Product')

  await prisma.$transaction(async (tx) => {
    await tx.product.update({ where: { id }, data: { active } })
    await writeAudit(tx, ctx, {
      action: active ? 'product.reactivated' : 'product.deactivated',
      entityType: 'Product',
      entityId: id,
      before: { active: existing.active },
      after: { active },
    })
  })
}

/** Barcode lookup for the sell screen — matches the product UPC or any UoM's barcode. */
export async function findByBarcode(
  ctx: AuthContext,
  barcode: string,
): Promise<ProductListItem | null> {
  requirePermission(ctx, 'product:read')

  const product = await db(ctx).product.findFirst({
    where: {
      active: true,
      OR: [{ upc: barcode }, { uoms: { some: { barcode, active: true } } }],
    },
    select: productListSelect,
  })

  return product ? toListItem(product) : null
}

export async function listCategories(ctx: AuthContext) {
  requirePermission(ctx, 'product:read')
  return db(ctx).productCategory.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, parentId: true, _count: { select: { products: true } } },
  })
}

export async function listSuppliers(ctx: AuthContext) {
  requirePermission(ctx, 'product:read')
  return db(ctx).supplier.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, contactName: true, phone: true, leadTimeDays: true },
  })
}

// ── internals ────────────────────────────────────────────────────────────────

const productListSelect = {
  id: true,
  sku: true,
  upc: true,
  name: true,
  brand: true,
  active: true,
  taxable: true,
  baseUomLabel: true,
  costPerBaseUnit: true,
  reorderPointBaseUnits: true,
  category: { select: { name: true } },
  supplier: { select: { name: true } },
  uoms: {
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true, code: true, label: true, baseUnitsPerUom: true,
      price: true, barcode: true, isBase: true, isDefaultSaleUom: true,
    },
  },
  balances: { select: { quantity: true } },
} satisfies Prisma.ProductSelect

type ProductRow = Prisma.ProductGetPayload<{ select: typeof productListSelect }>

function toUomDto(uom: ProductRow['uoms'][number]): ProductUomDto {
  return {
    id: uom.id,
    code: uom.code,
    label: uom.label,
    baseUnitsPerUom: uom.baseUnitsPerUom,
    price: toAmountString(uom.price),
    barcode: uom.barcode,
    isBase: uom.isBase,
    isDefaultSaleUom: uom.isDefaultSaleUom,
  }
}

function toListItem(product: ProductRow): ProductListItem {
  const base = product.uoms.find((u) => u.isBase)
  const pack = product.uoms.find((u) => !u.isBase && u.baseUnitsPerUom > 1)
  const unitsPerCase = pack?.baseUnitsPerUom ?? 1
  const onHand = product.balances.reduce((n, b) => n + b.quantity, 0)

  return {
    id: product.id,
    sku: product.sku,
    upc: product.upc,
    name: product.name,
    brand: product.brand,
    categoryName: product.category?.name ?? null,
    supplierName: product.supplier?.name ?? null,
    active: product.active,
    taxable: product.taxable,
    baseUomLabel: product.baseUomLabel,
    unitsPerCase,
    casePrice: pack ? toAmountString(pack.price) : null,
    unitPrice: toAmountString(base?.price ?? 0),
    costPerBaseUnit: toCostString(product.costPerBaseUnit),
    onHandBaseUnits: onHand,
    onHandLabel: formatQuantity(onHand, unitsPerCase),
    reorderPointBaseUnits: product.reorderPointBaseUnits,
    belowReorderPoint:
      product.reorderPointBaseUnits > 0 && onHand <= product.reorderPointBaseUnits,
  }
}

function scalarFields(input: ProductInput) {
  return {
    sku: input.sku,
    upc: input.upc || null,
    name: input.name,
    description: input.description || null,
    brand: input.brand || null,
    categoryId: input.categoryId || null,
    supplierId: input.supplierId || null,
    baseUomLabel: input.baseUomLabel,
    costPerBaseUnit: input.costPerBaseUnit,
    reorderPointBaseUnits: input.reorderPointBaseUnits,
    taxable: input.taxable,
    active: input.active,
    weightGrams: input.weightGrams ?? null,
    notes: input.notes || null,
  }
}

/**
 * The default sale unit is the largest package a product comes in — a runner
 * selling Takis reaches for a case, not a bag. Flags are derived here so create
 * and update cannot disagree about them.
 */
function uomFlags(uoms: ProductInput['uoms']) {
  const largest = uoms.reduce((a, b) => (b.baseUnitsPerUom > a.baseUnitsPerUom ? b : a), uoms[0])
  const ordered = [...uoms].sort((a, b) => a.baseUnitsPerUom - b.baseUnitsPerUom)

  return (uom: ProductInput['uoms'][number]) => ({
    code: uom.code,
    label: uom.label,
    baseUnitsPerUom: uom.baseUnitsPerUom,
    price: uom.price,
    barcode: uom.barcode || null,
    isBase: uom.baseUnitsPerUom === 1,
    isDefaultSaleUom: uom.code === largest.code,
    sortOrder: ordered.findIndex((u) => u.code === uom.code),
    active: true,
  })
}

/**
 * Every product must have exactly one base unit, and packaging factors must be
 * distinct — two "cases" of different sizes would make stock ambiguous.
 */
function assertUomSetIsCoherent(input: ProductInput): void {
  const bases = input.uoms.filter((u) => u.baseUnitsPerUom === 1)
  if (bases.length === 0) {
    throw conflict('A product needs a base unit — one package holding a single item.')
  }
  if (bases.length > 1) {
    throw conflict('A product can only have one base unit.')
  }
  const codes = new Set<string>()
  for (const uom of input.uoms) {
    if (codes.has(uom.code)) {
      throw conflict(`This product has two "${uom.code}" units. Give them different types.`)
    }
    codes.add(uom.code)
  }
}

async function assertSkuAndUpcFree(
  ctx: AuthContext,
  sku: string,
  upc: string | null,
  excludeId: string | null,
): Promise<void> {
  const prisma = db(ctx)
  const not = excludeId ? { NOT: { id: excludeId } } : {}

  const bySku = await prisma.product.findFirst({ where: { sku, ...not }, select: { name: true } })
  if (bySku) throw conflict(`SKU ${sku} is already used by ${bySku.name}.`)

  if (upc) {
    const byUpc = await prisma.product.findFirst({ where: { upc, ...not }, select: { name: true } })
    if (byUpc) throw conflict(`UPC ${upc} is already used by ${byUpc.name}.`)
  }
}
