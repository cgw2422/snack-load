import { NextResponse } from 'next/server'
import { completeStop } from '@/server/services/routerun.service'
import { stopOutcomeSchema } from '@/lib/schemas/routes'
import { queuedMutationSchema } from '@/lib/schemas/offline'
import { apiError, requireApiAuth } from '@/app/api/v1/_lib/handler'

/**
 * Finishing a stop over REST, for the offline queue (docs/05 §3).
 *
 * Replay-safe by the nature of the operation rather than by a key: asking for
 * an outcome the stop already has is success, because the stop is already
 * where it is being asked to go. A different finished outcome is a genuine
 * conflict and is refused.
 */
export async function POST(request: Request, context: RouteContext<'/api/v1/route-stops/[id]/outcome'>) {
  try {
    const ctx = await requireApiAuth()
    const { id } = await context.params
    const envelope = queuedMutationSchema.parse(await request.json())
    const input = stopOutcomeSchema.parse({ ...(envelope.payload as object), stopId: id })

    return NextResponse.json(await completeStop(ctx, input))
  } catch (error) {
    return apiError(error)
  }
}
