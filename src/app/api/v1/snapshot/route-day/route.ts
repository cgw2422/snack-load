import { getRouteDay } from '@/server/services/offline.service'
import { apiError, requireApiAuth, snapshotResponse } from '@/app/api/v1/_lib/handler'

/**
 * Today's route for whoever is signed in (docs/05 §2).
 *
 * The runner's phone keeps this so the stop list, the addresses and the phone
 * numbers survive a dead zone. Stale-while-revalidate: the list is settled at
 * dispatch, so yesterday's copy of it is wrong in a way a runner notices, but
 * a copy from twenty minutes ago is not.
 */
export async function GET() {
  try {
    const ctx = await requireApiAuth()
    return snapshotResponse(await getRouteDay(ctx))
  } catch (error) {
    return apiError(error)
  }
}
