import { z } from 'zod'

/**
 * Shared by the Server Actions, the REST handlers and the import validator, so
 * a spreadsheet and a form can never disagree about what a valid product is.
 */

/** Accepts "1,234.56", "$19.50", "19.50" — what people actually paste. */
export const moneyString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).replace(/[$,\s]/g, '').trim())
  .refine((v) => v === '' || /^-?\d+(\.\d+)?$/.test(v), 'Enter a valid amount')
  .transform((v) => (v === '' ? '0' : v))

export const positiveMoney = moneyString.refine(
  (v) => Number(v) >= 0,
  'Amount cannot be negative',
)

export const uomCodeSchema = z.enum(['EACH', 'CASE', 'BOX', 'PACK', 'TRAY', 'CUSTOM'])

export const productUomSchema = z.object({
  id: z.string().optional(),
  code: uomCodeSchema,
  label: z.string().trim().min(1, 'Give this unit a name').max(40),
  baseUnitsPerUom: z.coerce
    .number()
    .int('Units per package must be a whole number')
    .min(1, 'A package holds at least one unit')
    .max(100_000),
  price: positiveMoney,
  barcode: z.string().trim().max(64).optional().or(z.literal('')),
})

export const productSchema = z.object({
  sku: z.string().trim().min(1, 'SKU is required').max(64),
  upc: z.string().trim().max(64).optional().or(z.literal('')),
  name: z.string().trim().min(1, 'Product name is required').max(200),
  description: z.string().trim().max(1000).optional().or(z.literal('')),
  brand: z.string().trim().max(120).optional().or(z.literal('')),
  categoryId: z.string().optional().or(z.literal('')),
  supplierId: z.string().optional().or(z.literal('')),
  baseUomLabel: z.string().trim().min(1, 'Name the individual unit').max(40).default('Each'),
  /** Cost of ONE base unit. Six decimals, because a case cost divides unevenly. */
  costPerBaseUnit: positiveMoney,
  reorderPointBaseUnits: z.coerce.number().int().min(0).max(10_000_000).default(0),
  taxable: z.coerce.boolean().default(true),
  active: z.coerce.boolean().default(true),
  weightGrams: z.coerce.number().int().min(0).max(1_000_000).optional().nullable(),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  uoms: z.array(productUomSchema).min(1, 'A product needs at least its base unit'),
})
export type ProductInput = z.infer<typeof productSchema>

export const categorySchema = z.object({
  name: z.string().trim().min(1, 'Category name is required').max(80),
  parentId: z.string().optional().or(z.literal('')),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  active: z.coerce.boolean().default(true),
})

export const supplierSchema = z.object({
  name: z.string().trim().min(1, 'Supplier name is required').max(160),
  accountNumber: z.string().trim().max(64).optional().or(z.literal('')),
  contactName: z.string().trim().max(120).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  email: z.string().trim().max(254).email('Enter a valid email').optional().or(z.literal('')),
  addressLine1: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().max(80).optional().or(z.literal('')),
  state: z.string().trim().max(40).optional().or(z.literal('')),
  postalCode: z.string().trim().max(20).optional().or(z.literal('')),
  leadTimeDays: z.coerce.number().int().min(0).max(365).optional().nullable(),
  active: z.coerce.boolean().default(true),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
})

export const paymentTermsSchema = z.enum(['COD', 'NET7', 'NET15', 'NET30', 'NET60'])
export const dayOfWeekSchema = z.enum([
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
])
export const frequencySchema = z.enum(['WEEKLY', 'BIWEEKLY', 'TRIWEEKLY', 'MONTHLY', 'CUSTOM'])

/** US ZIP, 5 or ZIP+4. Kept loose enough not to reject a legitimate Canadian route later. */
export const postalCodeSchema = z
  .string()
  .trim()
  .max(20)
  .refine(
    (v) => v === '' || /^\d{5}(-\d{4})?$/.test(v) || /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/.test(v),
    'Enter a valid ZIP or postal code',
  )

export const customerSchema = z.object({
  accountNumber: z.string().trim().min(1, 'Account number is required').max(64),
  name: z.string().trim().min(1, 'Store name is required').max(200),
  parentCompany: z.string().trim().max(160).optional().or(z.literal('')),
  addressLine1: z.string().trim().max(200).optional().or(z.literal('')),
  addressLine2: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().max(80).optional().or(z.literal('')),
  state: z.string().trim().max(40).optional().or(z.literal('')),
  postalCode: postalCodeSchema.optional().or(z.literal('')),
  latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
  longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  email: z.string().trim().max(254).email('Enter a valid email').optional().or(z.literal('')),
  priceGroupId: z.string().optional().or(z.literal('')),
  paymentTermsCode: paymentTermsSchema.default('COD'),
  creditLimit: positiveMoney.optional().nullable(),
  taxExempt: z.coerce.boolean().default(false),
  taxExemptId: z.string().trim().max(64).optional().or(z.literal('')),
  taxRateId: z.string().optional().or(z.literal('')),
  deliveryInstructions: z.string().trim().max(1000).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  active: z.coerce.boolean().default(true),
  contactName: z.string().trim().max(120).optional().or(z.literal('')),
})
export type CustomerInput = z.infer<typeof customerSchema>

export const customerScheduleSchema = z.object({
  routeTemplateId: z.string().min(1, 'Choose a route'),
  frequency: frequencySchema.default('WEEKLY'),
  dayOfWeek: dayOfWeekSchema,
  intervalDays: z.coerce.number().int().min(1).max(365).optional().nullable(),
  weekOfCycle: z.coerce.number().int().min(1).max(4).optional().nullable(),
  sequence: z.coerce.number().int().min(0).max(9999).default(0),
  windowStart: z.string().trim().max(5).optional().or(z.literal('')),
  windowEnd: z.string().trim().max(5).optional().or(z.literal('')),
})

export const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  categoryId: z.string().optional(),
  supplierId: z.string().optional(),
  routeTemplateId: z.string().optional(),
  runnerUserId: z.string().optional(),
  status: z.enum(['all', 'active', 'inactive']).default('active'),
  sort: z.string().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
export type ListQuery = z.infer<typeof listQuerySchema>

export const bulkCustomerActionSchema = z.object({
  customerIds: z.array(z.string().min(1)).min(1, 'Select at least one store').max(5000),
  action: z.enum([
    'assign_route', 'assign_runner', 'set_visit_day', 'set_frequency',
    'set_terms', 'set_price_group', 'activate', 'deactivate',
  ]),
  routeTemplateId: z.string().optional(),
  runnerUserId: z.string().optional(),
  dayOfWeek: dayOfWeekSchema.optional(),
  frequency: frequencySchema.optional(),
  paymentTermsCode: paymentTermsSchema.optional(),
  priceGroupId: z.string().optional(),
})
export type BulkCustomerAction = z.infer<typeof bulkCustomerActionSchema>
