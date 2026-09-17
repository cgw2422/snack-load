import { z } from 'zod'

/**
 * Return, credit and refund inputs (spec §1–§9).
 *
 * The client says what is coming back, why, where it should go and what the
 * money should do. It never sends a price, a tax figure or a credit total —
 * those come from the original sale, server-side, exactly as with a cart.
 */

const money = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, 'Use an amount like 19.50')

export const RETURN_REASONS = [
  'DAMAGED',
  'EXPIRED',
  'WRONG_ITEM',
  'UNSOLD',
  'SWAP',
  'PRICING_ERROR',
  'DELIVERY_ERROR',
  'OTHER',
] as const

export const RETURN_DISPOSITIONS = [
  'RESTOCK_TRUCK',
  'RESTOCK_WAREHOUSE',
  'DAMAGED',
  'EXPIRED',
  'SUPPLIER_RETURN',
  'NONE',
] as const

export const returnLineSchema = z.object({
  /** The exact sale line being returned against. */
  saleItemId: z.string().min(1, 'Choose which line is coming back'),
  /** Quantity in the unit the line was sold in. */
  quantity: z.coerce.number().int().min(1, 'Return at least one'),
  disposition: z.enum(RETURN_DISPOSITIONS),
  reason: z.enum(RETURN_REASONS).optional(),
})

export const createReturnSchema = z.object({
  saleId: z.string().min(1, 'Choose the original sale'),
  reason: z.enum(RETURN_REASONS),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  routeStopId: z.string().optional().or(z.literal('')),
  lines: z.array(returnLineSchema).min(1, 'Choose at least one item to return'),
  /** What the money does. Independent of where the goods go (spec §3). */
  financialAction: z.enum(['APPLY_TO_BALANCE', 'ACCOUNT_CREDIT', 'REFUND', 'NONE']),
  /** Only read when financialAction is REFUND. */
  refund: z
    .object({
      method: z.enum(['CASH', 'CHECK', 'CARD', 'ACH', 'OTHER']),
      referenceNumber: z.string().trim().max(64).optional().or(z.literal('')),
      notes: z.string().trim().max(500).optional().or(z.literal('')),
    })
    .nullable()
    .optional(),
  idempotencyKey: z.string().uuid(),
})
export type CreateReturnInput = z.infer<typeof createReturnSchema>

/**
 * A credit with nothing coming back (spec §3, "No Physical Return"): a pricing
 * mistake, a goodwill credit. It never touches inventory, so it never reverses
 * COGS either.
 */
export const createAdjustmentCreditSchema = z.object({
  customerId: z.string().min(1, 'Choose a store'),
  saleId: z.string().optional().or(z.literal('')),
  reason: z.enum(RETURN_REASONS),
  description: z.string().trim().min(3, 'Say what this credit is for').max(200),
  amount: money,
  /** Tax to reverse alongside the merchandise. Zero unless the caller says so. */
  taxAmount: money.optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  financialAction: z.enum(['APPLY_TO_BALANCE', 'ACCOUNT_CREDIT']),
  idempotencyKey: z.string().uuid(),
})
export type CreateAdjustmentCreditInput = z.infer<typeof createAdjustmentCreditSchema>

export const applyCreditSchema = z.object({
  creditMemoId: z.string().min(1),
  /** Omit to apply oldest-first across every open invoice. */
  allocations: z
    .array(z.object({ saleId: z.string().min(1), amount: money }))
    .optional(),
})
export type ApplyCreditInput = z.infer<typeof applyCreditSchema>

export const createRefundSchema = z.object({
  creditMemoId: z.string().min(1),
  amount: money,
  method: z.enum(['CASH', 'CHECK', 'CARD', 'ACH', 'OTHER']),
  referenceNumber: z.string().trim().max(64).optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  idempotencyKey: z.string().uuid(),
})
export type CreateRefundInput = z.infer<typeof createRefundSchema>

export const voidDocumentSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().min(3, 'Say why this is being voided').max(500),
})
