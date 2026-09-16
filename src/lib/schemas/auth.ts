import { z } from 'zod'

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .max(254)
  .email('Enter a valid email address')
  .transform((v) => v.toLowerCase())

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'Use at most 200 characters')
  .refine((v) => /[a-zA-Z]/.test(v), 'Include at least one letter')
  .refine((v) => /[0-9]/.test(v), 'Include at least one number')

export const registerSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is required').max(120),
  firstName: z.string().trim().min(1, 'First name is required').max(60),
  lastName: z.string().trim().min(1, 'Last name is required').max(60),
  email: emailSchema,
  password: passwordSchema,
  phone: z.string().trim().max(40).optional().or(z.literal('')),
})
export type RegisterInput = z.infer<typeof registerSchema>

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(200),
})
export type LoginInput = z.infer<typeof loginSchema>

export const inviteSchema = z.object({
  email: emailSchema,
  roleKey: z.enum(['owner', 'admin', 'runner', 'warehouse', 'office']),
})
export type InviteInput = z.infer<typeof inviteSchema>

export const acceptInviteSchema = z.object({
  token: z.string().min(10),
  firstName: z.string().trim().min(1, 'First name is required').max(60),
  lastName: z.string().trim().min(1, 'Last name is required').max(60),
  password: passwordSchema,
})
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>
