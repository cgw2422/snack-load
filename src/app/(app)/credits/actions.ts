'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { isAppError } from '@/lib/errors'
import { requireAuth } from '@/server/auth/context'
import {
  applyCreditSchema,
  createRefundSchema,
  createReturnSchema,
  voidDocumentSchema,
} from '@/lib/schemas/returns'
import { createReturn, voidReturn } from '@/server/services/return.service'
import {
  applyCreditMemo,
  issueRefund,
  unapplyCreditMemo,
  voidCreditMemo,
  voidRefund,
} from '@/server/services/credit.service'
import {
  emailReceipt,
  shareLinkForReceipt,
  textReceipt,
} from '@/server/services/delivery.service'

export type CreditState = {
  error?: string
  message?: string
  creditMemoId?: string
  returnId?: string
}

function toState(error: unknown, fallback: string): CreditState {
  if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? fallback }
  if (isAppError(error)) return { error: error.message }
  console.error('[credits] failed', error)
  return { error: fallback }
}

/**
 * Posting a return (spec §16).
 *
 * The form sends what is coming back, where each line goes and what the money
 * should do. Every price, tax figure and credit total is computed on the server
 * from the original sale — the client never sends money.
 */
export async function createReturnAction(
  _prev: CreditState,
  formData: FormData,
): Promise<CreditState> {
  try {
    const ctx = await requireAuth()

    const lines = JSON.parse(String(formData.get('lines') ?? '[]')) as unknown[]
    const method = String(formData.get('refundMethod') ?? 'CASH')
    const financialAction = String(formData.get('financialAction') ?? 'ACCOUNT_CREDIT')

    const input = createReturnSchema.parse({
      saleId: formData.get('saleId'),
      reason: formData.get('reason'),
      notes: formData.get('notes') || undefined,
      routeStopId: formData.get('routeStopId') || undefined,
      lines,
      financialAction,
      refund:
        financialAction === 'REFUND'
          ? {
              method,
              referenceNumber: formData.get('refundReference') || undefined,
              notes: formData.get('refundNotes') || undefined,
            }
          : null,
      idempotencyKey: formData.get('idempotencyKey'),
    })

    const result = await createReturn(ctx, input)

    revalidatePath(`/receipts/${input.saleId}`)
    revalidatePath('/receivables')
    revalidatePath('/receipts')

    return {
      creditMemoId: result.creditMemoId ?? undefined,
      returnId: result.returnId,
      message: result.replayed
        ? 'That return was already recorded.'
        : creditSentence(result),
    }
  } catch (error) {
    return toState(error, 'That return could not be recorded.')
  }
}

function creditSentence(result: {
  returnNumber: string
  creditMemoNumber: string | null
  creditTotal: string
  applied: string
  refunded: string
  remainingCredit: string
}): string {
  if (!result.creditMemoNumber) return `${result.returnNumber} recorded. No credit was issued.`

  const tail =
    Number(result.refunded) > 0
      ? `refunded ${result.refunded}`
      : Number(result.applied) > 0
        ? `applied ${result.applied} to the balance`
        : `left ${result.remainingCredit} as credit on the account`

  return `${result.creditMemoNumber} for ${result.creditTotal} — ${tail}.`
}

export async function applyCreditAction(
  _prev: CreditState,
  formData: FormData,
): Promise<CreditState> {
  try {
    const ctx = await requireAuth()
    const input = applyCreditSchema.parse({ creditMemoId: formData.get('creditMemoId') })
    const result = await applyCreditMemo(ctx, input)

    revalidatePath(`/credits/${input.creditMemoId}`)
    revalidatePath('/receivables')

    return {
      message:
        result.invoices.length === 0
          ? 'There are no open invoices to apply this credit to.'
          : `Applied ${result.applied} to ${result.invoices.map((i) => i.saleNumber).join(', ')}.`,
    }
  } catch (error) {
    return toState(error, 'That credit could not be applied.')
  }
}

export async function unapplyCreditAction(
  _prev: CreditState,
  formData: FormData,
): Promise<CreditState> {
  try {
    const ctx = await requireAuth()
    const creditMemoId = String(formData.get('creditMemoId') ?? '')
    const result = await unapplyCreditMemo(ctx, creditMemoId)

    revalidatePath(`/credits/${creditMemoId}`)
    revalidatePath('/receivables')

    return { message: `Took ${result.restored} back off the invoices it was applied to.` }
  } catch (error) {
    return toState(error, 'That credit could not be unapplied.')
  }
}

export async function refundCreditAction(
  _prev: CreditState,
  formData: FormData,
): Promise<CreditState> {
  try {
    const ctx = await requireAuth()
    const input = createRefundSchema.parse({
      creditMemoId: formData.get('creditMemoId'),
      amount: formData.get('amount'),
      method: formData.get('method'),
      referenceNumber: formData.get('referenceNumber') || undefined,
      notes: formData.get('notes') || undefined,
      idempotencyKey: formData.get('idempotencyKey'),
    })

    const result = await issueRefund(ctx, input)
    revalidatePath(`/credits/${input.creditMemoId}`)
    revalidatePath('/receivables')

    return {
      message: result.replayed
        ? 'That refund was already recorded.'
        : `${result.refundNumber} for ${result.amount}. ${result.remainingCredit} credit left.`,
    }
  } catch (error) {
    return toState(error, 'That refund could not be recorded.')
  }
}

export async function voidReturnAction(
  _prev: CreditState,
  formData: FormData,
): Promise<CreditState> {
  try {
    const ctx = await requireAuth()
    const input = voidDocumentSchema.parse({
      id: formData.get('returnId'),
      reason: formData.get('reason'),
    })
    await voidReturn(ctx, input.id, input.reason)
    revalidatePath('/receipts')
    revalidatePath('/receivables')
    return { message: 'Return voided. The goods have gone back out and the credit is cancelled.' }
  } catch (error) {
    return toState(error, 'That return could not be voided.')
  }
}

export async function voidCreditAction(
  _prev: CreditState,
  formData: FormData,
): Promise<CreditState> {
  try {
    const ctx = await requireAuth()
    const input = voidDocumentSchema.parse({
      id: formData.get('creditMemoId'),
      reason: formData.get('reason'),
    })
    await voidCreditMemo(ctx, input.id, input.reason)
    revalidatePath(`/credits/${input.id}`)
    return { message: 'Credit memo voided.' }
  } catch (error) {
    return toState(error, 'That credit memo could not be voided.')
  }
}

export async function voidRefundAction(
  _prev: CreditState,
  formData: FormData,
): Promise<CreditState> {
  try {
    const ctx = await requireAuth()
    const input = voidDocumentSchema.parse({
      id: formData.get('refundId'),
      reason: formData.get('reason'),
    })
    await voidRefund(ctx, input.id, input.reason)
    revalidatePath('/receivables')
    return { message: 'Refund voided. The credit is back on the account.' }
  } catch (error) {
    return toState(error, 'That refund could not be voided.')
  }
}

export async function emailCreditAction(
  _prev: CreditState,
  formData: FormData,
): Promise<CreditState> {
  try {
    const ctx = await requireAuth()
    const id = String(formData.get('creditMemoId') ?? '')
    const to = String(formData.get('to') ?? '').trim()

    const result = await emailReceipt(ctx, {
      document: { kind: 'creditMemo', id },
      to: to || null,
      message: String(formData.get('message') ?? '').trim() || null,
    })
    revalidatePath(`/credits/${id}`)

    return result.status === 'SENT'
      ? { message: `Emailed to ${result.destination}.` }
      : { error: result.failureReason ?? 'That email could not be sent.' }
  } catch (error) {
    return toState(error, 'That email could not be sent.')
  }
}

export async function textCreditAction(
  _prev: CreditState,
  formData: FormData,
): Promise<CreditState> {
  try {
    const ctx = await requireAuth()
    const id = String(formData.get('creditMemoId') ?? '')
    const to = String(formData.get('to') ?? '').trim()

    const result = await textReceipt(ctx, { document: { kind: 'creditMemo', id }, to: to || null })
    revalidatePath(`/credits/${id}`)

    return result.status === 'SENT'
      ? { message: `Texted to ${result.destination}.` }
      : { error: result.failureReason ?? 'That text could not be sent.' }
  } catch (error) {
    return toState(error, 'That text could not be sent.')
  }
}

export async function creditShareLinkAction(
  creditMemoId: string,
): Promise<{ url?: string; error?: string }> {
  try {
    const ctx = await requireAuth()
    const { shareUrl } = await shareLinkForReceipt(ctx, { kind: 'creditMemo', id: creditMemoId })
    return { url: shareUrl }
  } catch (error) {
    return { error: toState(error, 'That link could not be created.').error }
  }
}
