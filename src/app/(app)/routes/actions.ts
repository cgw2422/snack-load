'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { isAppError } from '@/lib/errors'
import {
  addStopSchema,
  buildRouteSchema,
  reassignSchema,
  reorderStopsSchema,
  routeTemplateSchema,
  stopOutcomeSchema,
} from '@/lib/schemas/routes'
import { requireAuth } from '@/server/auth/context'
import {
  addStop,
  buildRoute,
  optimizeRoute,
  reassignStops,
  removeStop,
  reorderStops,
  saveRouteTemplate,
} from '@/server/services/route.service'
import {
  addStopNote,
  arriveAtStop,
  completeStop,
  startRoute,
} from '@/server/services/routerun.service'

export type RouteState = { error?: string; message?: string; routeId?: string }

function toState(error: unknown, fallback: string): RouteState {
  if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? fallback }
  if (isAppError(error)) return { error: error.message }
  console.error('[routes] failed', error)
  return { error: fallback }
}

export async function buildRouteAction(
  _prev: RouteState,
  formData: FormData,
): Promise<RouteState> {
  let destination: string
  try {
    const ctx = await requireAuth()
    const selected = formData.getAll('customerIds').map(String)
    const input = buildRouteSchema.parse({
      routeTemplateId: formData.get('routeTemplateId'),
      serviceDate: formData.get('serviceDate'),
      runnerUserId: formData.get('runnerUserId'),
      vehicleId: formData.get('vehicleId') || undefined,
      customerIds: selected.length > 0 ? selected : undefined,
      optimize: formData.get('optimize') === 'on',
    })

    const result = await buildRoute(ctx, input)
    revalidatePath('/routes')
    destination = `/routes/${result.routeId}`
  } catch (error) {
    return toState(error, 'That route could not be built.')
  }
  redirect(destination)
}

export async function saveRouteTemplateAction(
  _prev: RouteState,
  formData: FormData,
): Promise<RouteState> {
  try {
    const ctx = await requireAuth()
    const id = String(formData.get('templateId') ?? '') || null
    const input = routeTemplateSchema.parse({
      name: formData.get('name'),
      code: formData.get('code') || undefined,
      dayOfWeek: formData.get('dayOfWeek') || undefined,
      defaultRunnerUserId: formData.get('defaultRunnerUserId') || undefined,
      defaultVehicleId: formData.get('defaultVehicleId') || undefined,
      active: formData.get('active') === 'on',
      notes: formData.get('notes') || undefined,
    })

    await saveRouteTemplate(ctx, id, input)
    revalidatePath('/routes/plan')
    return { message: id ? 'Route updated.' : 'Route created.' }
  } catch (error) {
    return toState(error, 'That route could not be saved.')
  }
}

export async function reorderStopsAction(formData: FormData): Promise<void> {
  const ctx = await requireAuth()
  const input = reorderStopsSchema.parse({
    routeId: formData.get('routeId'),
    stopIds: String(formData.get('stopIds') ?? '').split(',').filter(Boolean),
  })
  await reorderStops(ctx, input.routeId, input.stopIds)
  revalidatePath(`/routes/${input.routeId}`)
}

export async function optimizeRouteAction(
  _prev: RouteState,
  formData: FormData,
): Promise<RouteState> {
  try {
    const ctx = await requireAuth()
    const routeId = String(formData.get('routeId') ?? '')
    const result = await optimizeRoute(ctx, routeId)
    revalidatePath(`/routes/${routeId}`)
    return {
      message:
        result.movedStops === 0
          ? 'Already in the best order we can find.'
          : `Reordered ${result.movedStops} stops · ${result.miles} miles, about ${Math.round(result.minutes / 60)}h ${result.minutes % 60}m.`,
    }
  } catch (error) {
    return toState(error, 'Those stops could not be reordered.')
  }
}

export async function addStopAction(_prev: RouteState, formData: FormData): Promise<RouteState> {
  try {
    const ctx = await requireAuth()
    const input = addStopSchema.parse({
      routeId: formData.get('routeId'),
      customerId: formData.get('customerId'),
    })
    await addStop(ctx, input.routeId, input.customerId)
    revalidatePath(`/routes/${input.routeId}`)
    return { message: 'Stop added.' }
  } catch (error) {
    return toState(error, 'That stop could not be added.')
  }
}

export async function removeStopAction(formData: FormData): Promise<void> {
  const ctx = await requireAuth()
  const routeId = String(formData.get('routeId') ?? '')
  await removeStop(ctx, String(formData.get('stopId') ?? ''))
  revalidatePath(`/routes/${routeId}`)
}

export async function reassignAction(_prev: RouteState, formData: FormData): Promise<RouteState> {
  try {
    const ctx = await requireAuth()
    const stopIds = formData.getAll('stopIds').map(String)
    const input = reassignSchema.parse({
      routeId: formData.get('routeId'),
      stopIds: stopIds.length > 0 ? stopIds : undefined,
      toUserId: formData.get('toUserId'),
      reason: formData.get('reason') || undefined,
    })

    const result = await reassignStops(ctx, input)
    revalidatePath('/routes')
    revalidatePath(`/routes/${input.routeId}`)
    return {
      message: `Moved ${result.movedStops} ${result.movedStops === 1 ? 'stop' : 'stops'}.`,
      routeId: result.targetRouteId,
    }
  } catch (error) {
    return toState(error, 'Those stops could not be moved.')
  }
}

export async function startRouteAction(formData: FormData): Promise<void> {
  const ctx = await requireAuth()
  const routeId = String(formData.get('routeId') ?? '')
  const odometer = formData.get('odometer')
  await startRoute(ctx, routeId, odometer ? Number(odometer) : null)
  revalidatePath(`/routes/${routeId}`)
  revalidatePath('/')
}

export async function arriveAction(formData: FormData): Promise<void> {
  const ctx = await requireAuth()
  const stopId = String(formData.get('stopId') ?? '')
  const routeId = String(formData.get('routeId') ?? '')

  const latitude = Number(formData.get('latitude'))
  const longitude = Number(formData.get('longitude'))
  const position =
    Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0
      ? { latitude, longitude }
      : null

  await arriveAtStop(ctx, stopId, position)
  revalidatePath(`/routes/${routeId}`)
}

export async function completeStopAction(
  _prev: RouteState,
  formData: FormData,
): Promise<RouteState> {
  try {
    const ctx = await requireAuth()
    const routeId = String(formData.get('routeId') ?? '')
    const input = stopOutcomeSchema.parse({
      stopId: formData.get('stopId'),
      outcome: formData.get('outcome'),
      reason: formData.get('reason') || undefined,
      notes: formData.get('notes') || undefined,
      rescheduledToDate: formData.get('rescheduledToDate') || undefined,
    })

    const result = await completeStop(ctx, input)
    revalidatePath(`/routes/${routeId}`)
    revalidatePath('/')

    return {
      message: result.routeCompleted
        ? 'Route complete. Nice work.'
        : 'Stop finished. On to the next one.',
      routeId: result.nextStopId ?? undefined,
    }
  } catch (error) {
    return toState(error, 'That stop could not be finished.')
  }
}

export async function addNoteAction(formData: FormData): Promise<void> {
  const ctx = await requireAuth()
  const stopId = String(formData.get('stopId') ?? '')
  const routeId = String(formData.get('routeId') ?? '')
  const note = String(formData.get('note') ?? '').trim()
  if (note) await addStopNote(ctx, stopId, note)
  revalidatePath(`/routes/${routeId}`)
}
