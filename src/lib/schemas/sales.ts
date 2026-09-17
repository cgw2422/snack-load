import { z } from 'zod'
import { positiveMoney } from './catalog'

export const saleLineSchema = z.object({
  productId: z.string().min(1),
  productUomId: z.string().min(1),
  quantity: z.coerce.number().int().min(1, 'Enter at least one').max(100_000),
  /** Only honoured for someone holding `price:override`. */
  manualPrice: positiveMoney.optional().nullable(),
  discountAmount: positiveMoney.optional().nullable(),
})

export const checkoutSchema = z.object({
  customerId: z.string().min(1, 'Choose a store'),
  routeStopId: z.string().optional().or(z.literal('')),
  lines: z.array(saleLineSchema).min(1, 'Add at least one product'),
  documentDiscount: positiveMoney.optional().nullable(),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  /** Minted when the cart is created, not when submit is pressed (docs/02 §I1). */
  idempotencyKey: z.string().uuid('A sale needs an idempotency key'),
  payment: z
    .object({
      method: z.enum(['CASH', 'CHECK', 'CARD', 'ACH', 'OTHER']),
      amount: positiveMoney,
      checkNumber: z.string().trim().max(32).optional().or(z.literal('')),
      referenceNumber: z.string().trim().max(64).optional().or(z.literal('')),
    })
    .optional()
    .nullable(),
  signature: z
    .object({
      signerName: z.string().trim().max(120).optional().or(z.literal('')),
      /** data:image/png;base64,… from the signature pad. */
      imageDataUrl: z.string().max(400_000),
    })
    .optional()
    .nullable(),
})
export type CheckoutInput = z.infer<typeof checkoutSchema>

export const recordPaymentSchema = z.object({
  customerId: z.string().min(1, 'Choose a store'),
  method: z.enum(['CASH', 'CHECK', 'CARD', 'ACH', 'OTHER']),
  amount: positiveMoney,
  checkNumber: z.string().trim().max(32).optional().or(z.literal('')),
  referenceNumber: z.string().trim().max(64).optional().or(z.literal('')),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  routeStopId: z.string().optional().or(z.literal('')),
  /** OLDEST_FIRST by default; SPECIFIC takes the allocations given. */
  strategy: z.enum(['OLDEST_FIRST', 'SPECIFIC']).default('OLDEST_FIRST'),
  allocations: z
    .array(z.object({ saleId: z.string().min(1), amount: positiveMoney }))
    .optional(),
  idempotencyKey: z.string().uuid(),
})
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>

export const voidSaleSchema = z.object({
  saleId: z.string().min(1),
  reason: z.string().trim().min(3, 'Say why this is being voided').max(500),
})

/**
 * The receipt book's filters (spec §25).
 *
 * Amounts are decimal strings, never numbers, all the way to the query — a
 * float here would be the one place money leaks into binary (docs/02 §M1).
 * Dates are calendar days in the organization's zone, resolved server-side.
 */
export const receiptQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  customerId: z.string().trim().min(1).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-17').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-17').optional(),
  /** open = still owed, overdue = owed past its due date. */
  status: z.enum(['all', 'paid', 'open', 'overdue', 'voided']).default('all'),
  minAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Use an amount like 25 or 25.00').optional(),
  maxAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Use an amount like 25 or 25.00').optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
})
export type ReceiptQuery = z.infer<typeof receiptQuerySchema>
