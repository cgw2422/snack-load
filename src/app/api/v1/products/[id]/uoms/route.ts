import { NextResponse } from 'next/server'
import { getProduct } from '@/server/services/product.service'
import { apiError, requireApiAuth } from '@/app/api/v1/_lib/handler'

/** The packaging a product can be counted or sold in. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiAuth()
    const { id } = await params
    const product = await getProduct(ctx, id)
    return NextResponse.json({
      productId: product.id,
      name: product.name,
      baseUomLabel: product.baseUomLabel,
      uoms: product.uoms,
    })
  } catch (error) {
    return apiError(error)
  }
}
