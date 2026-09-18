import { getTruckBalances } from '@/server/services/offline.service'
import { apiError, requireApiAuth, snapshotResponse } from '@/app/api/v1/_lib/handler'

/**
 * What is on the truck, in base units (docs/05 §2).
 *
 * The one read the client will not show without its age: quantities move with
 * every sale, and a stale count presented as live is how a runner promises
 * stock they no longer have.
 */
export async function GET() {
  try {
    const ctx = await requireApiAuth()
    return snapshotResponse(await getTruckBalances(ctx))
  } catch (error) {
    return apiError(error)
  }
}
