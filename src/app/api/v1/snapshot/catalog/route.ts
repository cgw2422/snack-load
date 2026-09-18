import { getTruckCatalog } from '@/server/services/offline.service'
import { apiError, requireApiAuth, snapshotResponse } from '@/app/api/v1/_lib/handler'

/** The products on this truck, with list prices for display (docs/05 §2). */
export async function GET() {
  try {
    const ctx = await requireApiAuth()
    return snapshotResponse(await getTruckCatalog(ctx))
  } catch (error) {
    return apiError(error)
  }
}
