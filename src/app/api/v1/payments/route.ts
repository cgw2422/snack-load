import { NextResponse } from 'next/server'
import { recordPayment } from '@/server/services/payment.service'
import { recordPaymentSchema } from '@/lib/schemas/sales'
import { queuedMutationSchema } from '@/lib/schemas/offline'
import { apiError, requireApiAuth } from '@/app/api/v1/_lib/handler'

/**
 * Recording a payment over REST, for the offline queue (docs/05 §3).
 *
 * Idempotent on the key the client minted when it took the money, so a
 * replayed payment settles the invoice once however many times it is sent.
 * Which invoices it settles is the server's decision, not the queue's.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireApiAuth()
    const envelope = queuedMutationSchema.parse(await request.json())
    const input = recordPaymentSchema.parse(envelope.payload)

    return NextResponse.json(await recordPayment(ctx, input))
  } catch (error) {
    return apiError(error)
  }
}
