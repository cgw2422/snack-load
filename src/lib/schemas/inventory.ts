import { z } from 'zod'
import { positiveMoney } from './catalog'

/** Shared by the inventory Server Actions, the REST handlers and the tests. */

export const lineQuantity = z.coerce
  .number()
  .int('Enter a whole number')
  .min(1, 'Enter at least one')
  .max(1_000_000)

export const receivingLineSchema = z.object({
  productId: z.string().min(1),
  productUomId: z.string().min(1),
  quantity: lineQuantity,
  /** Cost of one of the chosen UoM — what the invoice says, not a derived figure. */
  unitCost: positiveMoney,
})

export const receivingSchema = z.object({
  supplierId: z.string().optional().or(z.literal('')),
  warehouseLocationId: z.string().min(1, 'Choose a warehouse'),
  referenceNumber: z.string().trim().max(64).optional().or(z.literal('')),
  receivedAt: z.string().optional(),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  idempotencyKey: z.string().uuid('A receipt needs an idempotency key'),
  lines: z.array(receivingLineSchema).min(1, 'Add at least one product'),
})
export type ReceivingInput = z.infer<typeof receivingSchema>

export const ADJUSTMENT_REASONS = [
  { value: 'DAMAGE', label: 'Damaged', direction: 'out' },
  { value: 'EXPIRED', label: 'Expired', direction: 'out' },
  { value: 'MISSING', label: 'Missing / shrinkage', direction: 'out' },
  { value: 'SAMPLE', label: 'Sample or giveaway', direction: 'out' },
  { value: 'CORRECTION', label: 'Correction', direction: 'either' },
  { value: 'COUNT_ADJUSTMENT', label: 'Physical count', direction: 'either' },
] as const

export const adjustmentTypeSchema = z.enum([
  'DAMAGE', 'EXPIRED', 'MISSING', 'SAMPLE', 'CORRECTION', 'COUNT_ADJUSTMENT',
])

export const adjustmentSchema = z.object({
  locationId: z.string().min(1, 'Choose a location'),
  type: adjustmentTypeSchema,
  /** Required: an adjustment nobody explained is an adjustment nobody can audit. */
  notes: z.string().trim().min(3, 'Say what happened').max(2000),
  idempotencyKey: z.string().uuid(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        productUomId: z.string().min(1),
        /** Signed, in the chosen UoM. For a count this is the counted total. */
        quantity: z.coerce.number().int().min(-1_000_000).max(1_000_000),
      }),
    )
    .min(1, 'Add at least one product'),
})
export type AdjustmentInput = z.infer<typeof adjustmentSchema>

export const transferSchema = z.object({
  fromLocationId: z.string().min(1, 'Choose where it is coming from'),
  toLocationId: z.string().min(1, 'Choose where it is going'),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  idempotencyKey: z.string().uuid(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        productUomId: z.string().min(1),
        quantity: lineQuantity,
      }),
    )
    .min(1, 'Add at least one product'),
})
export type TransferInput = z.infer<typeof transferSchema>

export const truckLoadSchema = z.object({
  vehicleId: z.string().min(1, 'Choose a truck'),
  warehouseLocationId: z.string().min(1, 'Choose a warehouse'),
  routeId: z.string().optional().or(z.literal('')),
  direction: z.enum(['LOAD', 'UNLOAD']).default('LOAD'),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  idempotencyKey: z.string().uuid(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        productUomId: z.string().min(1),
        quantity: lineQuantity,
      }),
    )
    .min(1, 'Add at least one product'),
})
export type TruckLoadInput = z.infer<typeof truckLoadSchema>

export const vehicleSchema = z.object({
  name: z.string().trim().min(1, 'Name this truck').max(80),
  truckNumber: z.string().trim().min(1, 'Give it a number').max(32),
  licensePlate: z.string().trim().max(32).optional().or(z.literal('')),
  assignedUserId: z.string().optional().or(z.literal('')),
  active: z.coerce.boolean().default(true),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
})
export type VehicleInput = z.infer<typeof vehicleSchema>
