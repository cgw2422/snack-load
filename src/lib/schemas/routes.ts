import { z } from 'zod'
import { dayOfWeekSchema, frequencySchema } from './catalog'

export const routeTemplateSchema = z.object({
  name: z.string().trim().min(1, 'Name this route').max(80),
  code: z.string().trim().max(16).optional().or(z.literal('')),
  color: z.string().trim().max(16).optional().or(z.literal('')),
  dayOfWeek: dayOfWeekSchema.optional().nullable(),
  defaultRunnerUserId: z.string().optional().or(z.literal('')),
  defaultVehicleId: z.string().optional().or(z.literal('')),
  active: z.coerce.boolean().default(true),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
})
export type RouteTemplateInput = z.infer<typeof routeTemplateSchema>

export const buildRouteSchema = z.object({
  routeTemplateId: z.string().min(1, 'Choose a route'),
  /** Calendar day, YYYY-MM-DD. */
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date'),
  runnerUserId: z.string().min(1, 'Choose a runner'),
  vehicleId: z.string().optional().or(z.literal('')),
  /** Accounts to include. Defaults to everything due when omitted. */
  customerIds: z.array(z.string().min(1)).optional(),
  optimize: z.coerce.boolean().default(true),
})
export type BuildRouteInput = z.infer<typeof buildRouteSchema>

export const reorderStopsSchema = z.object({
  routeId: z.string().min(1),
  /** Stop ids in their new order. */
  stopIds: z.array(z.string().min(1)).min(1),
})

export const reassignSchema = z.object({
  routeId: z.string().min(1),
  /** Omitted means the whole remaining route. */
  stopIds: z.array(z.string().min(1)).optional(),
  toUserId: z.string().min(1, 'Choose who is taking this on'),
  /** Where the stops land. Omitted creates a route for that runner on the day. */
  targetRouteId: z.string().optional(),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
})
export type ReassignInput = z.infer<typeof reassignSchema>

export const stopOutcomeSchema = z.object({
  stopId: z.string().min(1),
  outcome: z.enum(['COMPLETED', 'NO_SALE', 'STORE_CLOSED', 'SKIPPED', 'RESCHEDULED']),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  rescheduledToDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
})
export type StopOutcomeInput = z.infer<typeof stopOutcomeSchema>

export const addStopSchema = z.object({
  routeId: z.string().min(1),
  customerId: z.string().min(1, 'Choose a store'),
})

export const customerScheduleInputSchema = z.object({
  customerId: z.string().min(1),
  routeTemplateId: z.string().min(1, 'Choose a route'),
  frequency: frequencySchema.default('WEEKLY'),
  dayOfWeek: dayOfWeekSchema,
  intervalDays: z.coerce.number().int().min(1).max(365).optional().nullable(),
  windowStart: z.string().trim().max(5).optional().or(z.literal('')),
  windowEnd: z.string().trim().max(5).optional().or(z.literal('')),
})
