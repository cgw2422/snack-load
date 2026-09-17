'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { isAppError } from '@/lib/errors'
import { checkoutSchema, recordPaymentSchema, voidSaleSchema } from '@/lib/schemas/sales'
import { requireAuth } from '@/server/auth/context'
import { checkout, priceCart, voidSale } from '@/server/services/sale.service'
import type { PricedCart } from '@/server/services/sale.service'
import { recordPayment } from '@/server/services/payment.service'

export type SellState = {
  error?: string
  message?: string
  saleId?: string
  receiptNumber?: string
}

function toState(error: unknown, fallback: string): SellState {
  if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? fallback }
  if (isAppError(error)) return { error: error.message }
  console.error('[sell] failed', error)
  return { error: fallback }
}

/**
 * Re-prices the cart on the server as the runner edits it. The client never
 * computes money — it sends intent and renders what comes back (docs/02 §M1).
 */
export async function priceCartAction(input: {
  customerId: string
  lines: { productId: string; productUomId: string; quantity: number }[]
}): Promise<{ cart?: PricedCart; error?: string }> {
  try {
    const ctx = await requireAuth()
    if (input.lines.length === 0) return {}
    return { cart: await priceCart(ctx, input) }
  } catch (error) {
    const state = toState(error, 'That cart could not be priced.')
    return { error: state.error }
  }
}

export async function checkoutAction(_prev: SellState, formData: FormData): Promise<SellState> {
  try {
    const ctx = await requireAuth()
    const raw = String(formData.get('cart') ?? '{}')
    const parsed = JSON.parse(raw) as Record<string, unknown>

    const tendered = String(formData.get('amount') ?? '').trim()
    const method = String(formData.get('method') ?? 'NONE')

    const input = checkoutSchema.parse({
      ...parsed,
      // The client attaches the key at submit time; it is stable across retries
      // of the same cart, which is what makes a replay safe (docs/02 §I1).
      idempotencyKey: formData.get('idempotencyKey') ?? parsed.idempotencyKey,
      notes: formData.get('notes') || undefined,
      payment:
        method === 'NONE' || !tendered || Number(tendered) <= 0
          ? null
          : {
              method,
              amount: tendered,
              checkNumber: formData.get('checkNumber') || undefined,
              referenceNumber: formData.get('referenceNumber') || undefined,
            },
      signature: formData.get('signatureData')
        ? {
            signerName: formData.get('signerName') || undefined,
            imageDataUrl: formData.get('signatureData'),
          }
        : null,
    })

    const result = await checkout(ctx, input)

    revalidatePath('/')
    revalidatePath('/customers')
    revalidatePath('/receipts')
    if (input.routeStopId) revalidatePath('/routes')

    return {
      saleId: result.saleId,
      receiptNumber: result.receiptNumber,
      message: result.replayed
        ? 'That sale was already recorded — the store has not been charged twice.'
        : `Sold ${result.total}.`,
    }
  } catch (error) {
    return toState(error, 'That sale could not be completed.')
  }
}

export async function recordPaymentAction(
  _prev: SellState,
  formData: FormData,
): Promise<SellState> {
  try {
    const ctx = await requireAuth()
    const input = recordPaymentSchema.parse({
      customerId: formData.get('customerId'),
      method: formData.get('method'),
      amount: formData.get('amount'),
      checkNumber: formData.get('checkNumber') || undefined,
      referenceNumber: formData.get('referenceNumber') || undefined,
      notes: formData.get('notes') || undefined,
      strategy: 'OLDEST_FIRST',
      idempotencyKey: formData.get('idempotencyKey'),
    })

    const result = await recordPayment(ctx, input)
    revalidatePath('/receivables')
    revalidatePath('/customers')

    return {
      message: result.replayed
        ? 'That payment was already recorded.'
        : result.unapplied === '0.00'
          ? `Applied ${result.applied}.`
          : `Applied ${result.applied}; ${result.unapplied} left as credit on the account.`,
    }
  } catch (error) {
    return toState(error, 'That payment could not be recorded.')
  }
}

export async function voidSaleAction(_prev: SellState, formData: FormData): Promise<SellState> {
  try {
    const ctx = await requireAuth()
    const input = voidSaleSchema.parse({
      saleId: formData.get('saleId'),
      reason: formData.get('reason'),
    })
    await voidSale(ctx, input.saleId, input.reason)
    revalidatePath(`/receipts/${input.saleId}`)
    revalidatePath('/receivables')
    return { message: 'Sale voided. Stock has gone back and the balance is cleared.' }
  } catch (error) {
    return toState(error, 'That sale could not be voided.')
  }
}
