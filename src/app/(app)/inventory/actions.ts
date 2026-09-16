'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { isAppError } from '@/lib/errors'
import {
  adjustmentSchema,
  receivingSchema,
  transferSchema,
  truckLoadSchema,
  vehicleSchema,
} from '@/lib/schemas/inventory'
import { requireAuth } from '@/server/auth/context'
import { adjustStock, receiveStock, transferStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock, updateVehicle } from '@/server/services/truckload.service'

export type StockState = {
  error?: string
  message?: string
  /** Set on success so the client can clear its lines and mint a fresh key. */
  done?: boolean
}

function toState(error: unknown, fallback: string): StockState {
  if (error instanceof z.ZodError) {
    return { error: error.issues[0]?.message ?? fallback }
  }
  if (isAppError(error)) return { error: error.message }
  console.error('[inventory] failed', error)
  return { error: fallback }
}

/** Line arrays arrive as a JSON string; a dozen indexed form fields would be worse. */
function parseLines(formData: FormData): unknown {
  const raw = formData.get('lines')
  try {
    return JSON.parse(String(raw ?? '[]'))
  } catch {
    return []
  }
}

function revalidateStock() {
  revalidatePath('/inventory')
  revalidatePath('/inventory/products')
  revalidatePath('/vehicles')
  revalidatePath('/')
}

export async function receiveStockAction(
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  try {
    const ctx = await requireAuth()
    const input = receivingSchema.parse({
      supplierId: formData.get('supplierId') || undefined,
      warehouseLocationId: formData.get('warehouseLocationId'),
      referenceNumber: formData.get('referenceNumber') || undefined,
      notes: formData.get('notes') || undefined,
      idempotencyKey: formData.get('idempotencyKey'),
      lines: parseLines(formData),
    })

    const result = await receiveStock(ctx, input)
    revalidateStock()

    return {
      done: true,
      message: result.replayed
        ? 'That shipment was already received — nothing was added twice.'
        : `Received ${input.lines.length} ${input.lines.length === 1 ? 'product' : 'products'} · ${result.reference}`,
    }
  } catch (error) {
    return toState(error, 'That shipment could not be received.')
  }
}

export async function adjustStockAction(
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  try {
    const ctx = await requireAuth()
    const input = adjustmentSchema.parse({
      locationId: formData.get('locationId'),
      type: formData.get('type'),
      notes: formData.get('notes'),
      idempotencyKey: formData.get('idempotencyKey'),
      lines: parseLines(formData),
    })

    const result = await adjustStock(ctx, input)
    revalidateStock()

    return {
      done: true,
      message: result.replayed ? 'That adjustment was already recorded.' : 'Adjustment recorded.',
    }
  } catch (error) {
    return toState(error, 'That adjustment could not be recorded.')
  }
}

export async function transferStockAction(
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  try {
    const ctx = await requireAuth()
    const input = transferSchema.parse({
      fromLocationId: formData.get('fromLocationId'),
      toLocationId: formData.get('toLocationId'),
      notes: formData.get('notes') || undefined,
      idempotencyKey: formData.get('idempotencyKey'),
      lines: parseLines(formData),
    })

    const result = await transferStock(ctx, input)
    revalidateStock()

    return {
      done: true,
      message: result.replayed ? 'That transfer was already recorded.' : 'Stock transferred.',
    }
  } catch (error) {
    return toState(error, 'That transfer could not be recorded.')
  }
}

export async function truckLoadAction(
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  try {
    const ctx = await requireAuth()
    const input = truckLoadSchema.parse({
      vehicleId: formData.get('vehicleId'),
      warehouseLocationId: formData.get('warehouseLocationId'),
      routeId: formData.get('routeId') || undefined,
      direction: formData.get('direction') || 'LOAD',
      notes: formData.get('notes') || undefined,
      idempotencyKey: formData.get('idempotencyKey'),
      lines: parseLines(formData),
    })

    const result = await moveTruckStock(ctx, input)
    revalidateStock()

    const verb = input.direction === 'LOAD' ? 'loaded' : 'unloaded'
    return {
      done: true,
      message: result.replayed
        ? `That truck was already ${verb} — nothing moved twice.`
        : `Truck ${verb}.`,
    }
  } catch (error) {
    return toState(error, 'That load could not be recorded.')
  }
}

export async function saveVehicleAction(
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  try {
    const ctx = await requireAuth()
    const id = String(formData.get('vehicleId') ?? '')
    const input = vehicleSchema.parse({
      name: formData.get('name'),
      truckNumber: formData.get('truckNumber'),
      licensePlate: formData.get('licensePlate') || undefined,
      assignedUserId: formData.get('assignedUserId') || undefined,
      active: formData.get('active') === 'on',
      notes: formData.get('notes') || undefined,
    })

    if (id) await updateVehicle(ctx, id, input)
    else await createVehicle(ctx, input)

    revalidatePath('/vehicles')
    return { done: true, message: id ? 'Truck updated.' : 'Truck added.' }
  } catch (error) {
    return toState(error, 'That truck could not be saved.')
  }
}
