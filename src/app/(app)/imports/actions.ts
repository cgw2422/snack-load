'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import type { ImportType } from '@/generated/prisma/enums'
import { isAppError } from '@/lib/errors'
import { requireAuth } from '@/server/auth/context'
import * as importService from '@/server/services/import.service'

export type UploadState = { error?: string }
export type MappingState = { error?: string; message?: string }

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

function toError(error: unknown, fallback: string) {
  if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? fallback }
  if (isAppError(error)) return { error: error.message }
  console.error('[import] failed', error)
  return { error: fallback }
}

export async function uploadImportAction(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  let destination: string
  try {
    const ctx = await requireAuth()
    const type = String(formData.get('type') ?? '') as ImportType
    const file = formData.get('file')

    if (!(file instanceof File) || file.size === 0) {
      return { error: 'Choose a CSV or Excel file to upload.' }
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return { error: 'That file is larger than 15 MB. Split it and try again.' }
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const job = await importService.createImportJob(ctx, { type, fileName: file.name, bytes })
    destination = `/imports/${job.jobId}`
  } catch (error) {
    return toError(error, 'That file could not be read.')
  }
  redirect(destination)
}

export async function validateImportAction(
  _prev: MappingState,
  formData: FormData,
): Promise<MappingState> {
  try {
    const ctx = await requireAuth()
    const jobId = String(formData.get('jobId') ?? '')

    // Column selects are named map:<fieldKey>; reference selects ref:<kind>:<value>.
    const mapping: Record<string, string> = {}
    const resolvedReferences: Record<string, string> = {}

    for (const [key, value] of formData.entries()) {
      const text = String(value)
      if (!text) continue
      if (key.startsWith('map:')) mapping[key.slice(4)] = text
      else if (key.startsWith('ref:')) resolvedReferences[key.slice(4)] = text
    }

    await importService.validateImportJob(ctx, jobId, {
      mapping,
      mode: (formData.get('mode') ?? 'UPSERT') as 'CREATE_ONLY' | 'UPDATE_ONLY' | 'UPSERT',
      matchKey: (formData.get('matchKey') ?? 'SKU') as 'SKU' | 'UPC' | 'ACCOUNT_NUMBER' | 'NAME',
      resolvedReferences,
    })

    revalidatePath(`/imports/${jobId}`)
    return { message: 'Checked every row.' }
  } catch (error) {
    return toError(error, 'Those rows could not be checked.')
  }
}

export async function commitImportAction(
  _prev: MappingState,
  formData: FormData,
): Promise<MappingState> {
  try {
    const ctx = await requireAuth()
    const jobId = String(formData.get('jobId') ?? '')
    const result = await importService.commitImportJob(ctx, jobId, {
      skipWarnings: formData.get('skipWarnings') === 'on',
    })

    revalidatePath(`/imports/${jobId}`)
    revalidatePath('/inventory/products')
    revalidatePath('/customers')

    return {
      message:
        result.failed > 0
          ? `Imported ${result.imported}. ${result.failed} rows failed and are listed below.`
          : `Imported ${result.imported} ${result.imported === 1 ? 'row' : 'rows'}.`,
    }
  } catch (error) {
    return toError(error, 'The import could not be completed.')
  }
}

export async function patchImportRowAction(formData: FormData): Promise<void> {
  const ctx = await requireAuth()
  const jobId = String(formData.get('jobId') ?? '')
  const rowId = String(formData.get('rowId') ?? '')
  const column = String(formData.get('column') ?? '')
  const value = String(formData.get('value') ?? '')

  await importService.patchImportRow(ctx, jobId, rowId, { [column]: value })
  revalidatePath(`/imports/${jobId}`)
}

export async function cancelImportAction(formData: FormData): Promise<void> {
  const ctx = await requireAuth()
  const jobId = String(formData.get('jobId') ?? '')
  await importService.cancelImportJob(ctx, jobId)
  redirect(String(formData.get('returnTo') ?? '/'))
}
