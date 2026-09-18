'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { isAppError } from '@/lib/errors'
import { requireAuth } from '@/server/auth/context'
import {
  backfill,
  beginConnect,
  disconnect,
  listQuickBooksAccounts,
  mapManually,
  resyncDocument,
  retryJob,
  saveSettings,
  syncNow,
} from '@/server/services/integration.service'
import {
  prepareCogsBatch,
  postCogsBatch,
  voidCogsBatch,
} from '@/server/services/cogs.service'
import { readSettings } from '@/server/integrations/quickbooks/settings'
import { describeConnection } from '@/server/services/integration.service'

export type IntegrationState = { error?: string; message?: string }

function toState(error: unknown, fallback: string): IntegrationState {
  if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? fallback }
  if (isAppError(error)) return { error: error.message }
  console.error('[quickbooks] action failed', error)
  return { error: fallback }
}

const PATH = '/settings/integrations/quickbooks'

/**
 * Connecting leaves the app: the redirect to Intuit has to be a real browser
 * navigation, not a fetch, because the person has to sign in over there.
 */
export async function connectAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  let url: string
  try {
    const ctx = await requireAuth()
    const environment = formData.get('environment') === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX'
    url = await beginConnect(ctx, environment)
  } catch (error) {
    return toState(error, 'Could not start the QuickBooks connection.')
  }
  redirect(url)
}

export async function disconnectAction(): Promise<IntegrationState> {
  try {
    await disconnect(await requireAuth())
    revalidatePath(PATH)
    return { message: 'QuickBooks disconnected. Nothing that already synced was removed.' }
  } catch (error) {
    return toState(error, 'Could not disconnect QuickBooks.')
  }
}

export async function syncNowAction(): Promise<IntegrationState> {
  try {
    const result = await syncNow(await requireAuth())
    revalidatePath(PATH)

    if (result.stoppedBecause === 'NO_CONNECTION') return { error: 'QuickBooks is not connected.' }
    if (result.stoppedBecause === 'AUTHORIZATION') {
      return { error: 'QuickBooks refused the connection. Reconnect to carry on.' }
    }
    if (result.processed === 0) return { message: 'Everything is already up to date.' }

    const parts = [`${result.synced} synced`]
    if (result.blocked > 0) parts.push(`${result.blocked} waiting on something else`)
    if (result.failed > 0) parts.push(`${result.failed} need attention`)
    return { message: parts.join(', ') + '.' }
  } catch (error) {
    return toState(error, 'Could not reach QuickBooks.')
  }
}

const accountRef = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .optional()

/** Reads one account picker back off the form, id and label together. */
function pickAccount(formData: FormData, key: string, accounts: { Id: string; Name: string }[]) {
  const id = String(formData.get(key) ?? '')
  if (!id) return undefined
  const account = accounts.find((entry) => entry.Id === id)
  // Store QuickBooks' own id, with the name alongside for display only. A
  // renamed account keeps working; a mapping keyed on the name would not.
  return account ? { id: account.Id, name: account.Name } : undefined
}

export async function saveSettingsAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  try {
    const ctx = await requireAuth()
    const accounts = await listQuickBooksAccounts(ctx)
    const current = (await describeConnection(ctx)).settings

    const settings = readSettings({
      ...current,
      accounts: {
        salesIncome: pickAccount(formData, 'salesIncome', accounts),
        returnsAndDiscounts: pickAccount(formData, 'returnsAndDiscounts', accounts),
        accountsReceivable: pickAccount(formData, 'accountsReceivable', accounts),
        undepositedFunds: pickAccount(formData, 'undepositedFunds', accounts),
        costOfGoodsSold: pickAccount(formData, 'costOfGoodsSold', accounts),
        inventoryAsset: pickAccount(formData, 'inventoryAsset', accounts),
        salesTaxPayable: pickAccount(formData, 'salesTaxPayable', accounts),
        refundClearing: pickAccount(formData, 'refundClearing', accounts),
      },
      tax: {
        ...current.tax,
        legacyPolicy: formData.get('legacyPolicy') === 'REVIEW' ? 'REVIEW' : 'TOTALS_ONLY',
      },
      documents: {
        sendDocumentNumbers: formData.get('sendDocumentNumbers') === 'on',
        referenceInPrivateNote: formData.get('referenceInPrivateNote') === 'on',
      },
      syncPaused: formData.get('syncPaused') === 'on',
    })

    await saveSettings(ctx, settings)
    revalidatePath(PATH)
    return { message: 'Saved. Anything that was waiting on a mapping will try again.' }
  } catch (error) {
    return toState(error, 'Could not save the QuickBooks settings.')
  }
}

export async function retryJobAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  try {
    await retryJob(await requireAuth(), String(formData.get('jobId') ?? ''))
    revalidatePath(PATH)
    return { message: 'Queued. It will go on the next sync.' }
  } catch (error) {
    return toState(error, 'Could not queue that document.')
  }
}

export async function resyncAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  try {
    await resyncDocument(
      await requireAuth(),
      String(formData.get('entityType') ?? ''),
      String(formData.get('localId') ?? ''),
    )
    revalidatePath(PATH)
    return { message: 'Queued as an update to the document QuickBooks already has.' }
  } catch (error) {
    return toState(error, 'Could not re-sync that document.')
  }
}

export async function mapManuallyAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  try {
    const entityType = formData.get('entityType') === 'Product' ? 'Product' : 'Customer'
    await mapManually(
      await requireAuth(),
      entityType,
      String(formData.get('localId') ?? ''),
      String(formData.get('externalId') ?? '').trim(),
    )
    revalidatePath(PATH)
    return { message: 'Mapped. Nothing new will be created in QuickBooks for it.' }
  } catch (error) {
    return toState(error, 'Could not save that mapping.')
  }
}

export async function backfillAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  try {
    const days = Number(formData.get('days') ?? 30)
    const since = new Date(Date.now() - Math.max(1, Math.min(365, days)) * 86_400_000)
    const result = await backfill(await requireAuth(), since)
    revalidatePath(PATH)
    return {
      message: `Queued ${result.sales} sales, ${result.payments} payments and ${result.credits} credits.`,
    }
  } catch (error) {
    return toState(error, 'Could not queue past documents.')
  }
}

export async function prepareCogsAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  try {
    const batch = await prepareCogsBatch(await requireAuth(), {
      from: String(formData.get('from') ?? ''),
      to: String(formData.get('to') ?? ''),
    })
    revalidatePath(PATH)
    return {
      message: `${batch.periodStart} to ${batch.periodEnd}: ${batch.totalCogs} from ${batch.saleCount} sales less ${batch.returnCount} credits. Nothing has been sent yet.`,
    }
  } catch (error) {
    return toState(error, 'Could not work out the cost for that period.')
  }
}

export async function postCogsAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  try {
    const batch = await postCogsBatch(await requireAuth(), String(formData.get('batchId') ?? ''))
    revalidatePath(PATH)
    return { message: `Posted ${batch.totalCogs}. It will reach QuickBooks on the next sync.` }
  } catch (error) {
    return toState(error, 'Could not post that COGS journal.')
  }
}

export async function voidCogsAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  try {
    await voidCogsBatch(
      await requireAuth(),
      String(formData.get('batchId') ?? ''),
      String(formData.get('reason') ?? 'Superseded'),
    )
    revalidatePath(PATH)
    return { message: 'Voided here. The QuickBooks journal entry was left alone.' }
  } catch (error) {
    return toState(error, 'Could not void that COGS journal.')
  }
}

void accountRef
