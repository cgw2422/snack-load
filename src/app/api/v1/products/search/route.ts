import { NextResponse } from 'next/server'
import { z } from 'zod'
import { listProducts, findByBarcode } from '@/server/services/product.service'
import { getLocationStock } from '@/server/services/receiving.service'
import { apiError, requireApiAuth } from '@/app/api/v1/_lib/handler'

const querySchema = z.object({
  q: z.string().trim().max(120).optional(),
  barcode: z.string().trim().max(64).optional(),
  /** When given, results carry what is on hand there. */
  locationId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/**
 * Product lookup for every line-item screen: receiving, adjustments, transfers,
 * truck loads and — from Phase 5 — the sell screen. A barcode hit returns that
 * one product, so a scan goes straight into the cart.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireApiAuth()
    const url = new URL(request.url)
    const query = querySchema.parse(Object.fromEntries(url.searchParams))

    if (query.barcode) {
      const hit = await findByBarcode(ctx, query.barcode)
      return NextResponse.json({ items: hit ? [toDto(hit)] : [] })
    }

    const { items } = await listProducts(ctx, {
      search: query.q,
      status: 'active',
      page: 1,
      pageSize: query.limit,
    })

    // One extra query beats N+1 lookups while someone types.
    const stock = query.locationId
      ? new Map((await getLocationStock(ctx, query.locationId)).map((s) => [s.productId, s]))
      : null

    return NextResponse.json({
      items: items.map((item) => ({
        ...toDto(item),
        onHand: stock?.get(item.id)?.quantity ?? 0,
      })),
    })
  } catch (error) {
    return apiError(error)
  }
}

type Listed = Awaited<ReturnType<typeof listProducts>>['items'][number]

function toDto(product: Listed) {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    baseUomLabel: product.baseUomLabel,
    unitsPerCase: product.unitsPerCase,
    casePrice: product.casePrice,
    unitPrice: product.unitPrice,
    costPerBaseUnit: product.costPerBaseUnit,
    onHandBaseUnits: product.onHandBaseUnits,
  }
}
