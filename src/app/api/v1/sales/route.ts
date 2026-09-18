import { NextResponse } from 'next/server'
import { checkout } from '@/server/services/sale.service'
import { checkoutSchema } from '@/lib/schemas/sales'
import { m, toAmountString } from '@/server/domain/money'
import { queuedMutationSchema, repricedAgainst } from '@/lib/schemas/offline'
import { apiError, requireApiAuth } from '@/app/api/v1/_lib/handler'

/**
 * Posting a sale over REST (docs/05 §3).
 *
 * This is what the offline queue replays against, and it is the same
 * `checkout` the sell screen's Server Action calls — one code path, so a
 * queued sale cannot behave differently from one taken with a signal.
 *
 * The body carries **intent only**: store, product, unit of measure, quantity.
 * No totals, no tax, no receipt number. The server prices it on arrival,
 * against today's prices and today's stock, and the answer it returns is the
 * truth. A client that computed money while offline and expected the server to
 * honour it is the design docs/05 explicitly refuses.
 *
 * `clientEstimate` is the one exception, and it is not authoritative: it is
 * what the runner was shown when the cart was built, so that a sale re-priced
 * on arrival can tell them the total moved rather than quietly charging
 * something else.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireApiAuth()
    const body = await request.json()

    const envelope = queuedMutationSchema.parse(body)
    const input = checkoutSchema.parse(envelope.payload)

    const result = await checkout(ctx, input)

    const estimate = envelope.clientEstimate

    return NextResponse.json({
      ...result,
      /** True when the server's figure differs from what the runner was shown. */
      repriced: repricedAgainst(estimate, result.total),
      clientEstimate: estimate ? toAmountString(m(estimate)) : null,
    })
  } catch (error) {
    return apiError(error)
  }
}
