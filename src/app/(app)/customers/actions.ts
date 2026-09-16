'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { isAppError } from '@/lib/errors'
import { bulkCustomerActionSchema } from '@/lib/schemas/catalog'
import { requireAuth } from '@/server/auth/context'
import { bulkUpdateCustomers, setCustomerActive } from '@/server/services/customer.service'

export type BulkState = { error?: string; message?: string; updated?: number; skipped?: number }

export async function bulkCustomerAction(
  _prev: BulkState,
  formData: FormData,
): Promise<BulkState> {
  try {
    const ctx = await requireAuth()
    const input = bulkCustomerActionSchema.parse({
      customerIds: formData.getAll('customerIds').map(String),
      action: formData.get('action'),
      routeTemplateId: formData.get('routeTemplateId') || undefined,
      runnerUserId: formData.get('runnerUserId') || undefined,
      dayOfWeek: formData.get('dayOfWeek') || undefined,
      frequency: formData.get('frequency') || undefined,
      paymentTermsCode: formData.get('paymentTermsCode') || undefined,
      priceGroupId: formData.get('priceGroupId') || undefined,
    })

    const result = await bulkUpdateCustomers(ctx, input)
    revalidatePath('/customers')

    return {
      message:
        result.skipped > 0
          ? `${result.message}. ${result.updated} updated, ${result.skipped} skipped.`
          : `${result.message} — ${result.updated} ${result.updated === 1 ? 'store' : 'stores'}.`,
      updated: result.updated,
      skipped: result.skipped,
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? 'Check your selection and try again.' }
    }
    if (isAppError(error)) return { error: error.message }
    console.error('[customers] bulk action failed', error)
    return { error: 'Something went wrong. Please try again.' }
  }
}

export async function setCustomerActiveAction(formData: FormData): Promise<void> {
  const ctx = await requireAuth()
  const id = String(formData.get('customerId') ?? '')
  await setCustomerActive(ctx, id, formData.get('active') === 'true')
  revalidatePath(`/customers/${id}`)
  revalidatePath('/customers')
}
