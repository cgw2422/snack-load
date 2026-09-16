'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { isAppError } from '@/lib/errors'
import { acceptInviteSchema, loginSchema, registerSchema } from '@/lib/schemas/auth'
import { SESSION_COOKIE, revokeSession, sessionCookieOptions } from '@/server/auth/session'
import { getAuthContext } from '@/server/auth/context'
import * as authService from '@/server/services/auth.service'
import type { SessionResult } from '@/server/services/auth.service'

/**
 * Web transport for authentication (docs/03 §3). These actions parse, delegate to
 * the service, and set a cookie. They contain no business rules — the identical
 * service functions back `/api/v1/auth/*` for the future native client.
 */

export type FormState = {
  error?: string
  fieldErrors?: Record<string, string[]>
}

function fieldErrorsFrom(error: z.ZodError): FormState {
  const fieldErrors: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_'
    ;(fieldErrors[key] ??= []).push(issue.message)
  }
  return { error: 'Please fix the highlighted fields.', fieldErrors }
}

function toFormState(error: unknown): FormState {
  if (error instanceof z.ZodError) return fieldErrorsFrom(error)
  if (isAppError(error)) return { error: error.message }
  console.error('[auth] unexpected failure', error)
  return { error: 'Something went wrong. Please try again.' }
}

async function requestMeta() {
  const h = await headers()
  return {
    userAgent: h.get('user-agent'),
    // Behind a proxy the left-most entry is the client; trust it only because
    // this value is used for display and rate-limiting, never for authorization.
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  }
}

async function establishSession(session: SessionResult): Promise<void> {
  const jar = await cookies()
  jar.set(
    SESSION_COOKIE,
    session.token,
    sessionCookieOptions(session.expiresAt, process.env.NODE_ENV === 'production'),
  )
}

export async function registerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let destination: string
  try {
    const input = registerSchema.parse(Object.fromEntries(formData))
    const session = await authService.registerOrganization(input, await requestMeta())
    await establishSession(session)
    destination = '/'
  } catch (error) {
    return toFormState(error)
  }
  redirect(destination)
}

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let destination: string
  try {
    const input = loginSchema.parse(Object.fromEntries(formData))
    const session = await authService.login(input, await requestMeta())
    await establishSession(session)

    const next = formData.get('next')
    // Only same-origin relative paths, so a crafted ?next= cannot bounce someone
    // off-site straight after they hand over a password.
    destination =
      typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  } catch (error) {
    return toFormState(error)
  }
  redirect(destination)
}

export async function acceptInviteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  let destination: string
  try {
    const input = acceptInviteSchema.parse(Object.fromEntries(formData))
    const session = await authService.acceptInvitation(input, await requestMeta())
    await establishSession(session)
    destination = '/'
  } catch (error) {
    return toFormState(error)
  }
  redirect(destination)
}

export async function logoutAction(): Promise<void> {
  const ctx = await getAuthContext()
  if (ctx) await revokeSession(ctx.sessionId)
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
  redirect('/login')
}
