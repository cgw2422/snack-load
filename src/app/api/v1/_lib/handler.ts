import { NextResponse } from 'next/server'
import { z } from 'zod'
import { AppError, isAppError } from '@/lib/errors'
import { getAuthContext, type AuthContext } from '@/server/auth/context'

/**
 * The REST wrapper (docs/03 §3).
 *
 * Parse → authenticate → call the service → serialize. It contains no business
 * rules: the same service functions back the Server Actions, so this surface
 * cannot drift from what the web app actually does. Auth accepts either carrier
 * of the session token — the cookie for the browser, a Bearer header for the
 * native app that will come later (docs/04 §2).
 */

export async function requireApiAuth(): Promise<AuthContext> {
  const ctx = await getAuthContext()
  if (!ctx) throw new AppError('UNAUTHENTICATED', 'Sign in to continue')
  return ctx
}

export function apiError(error: unknown): NextResponse {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some fields are not valid.',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
      { status: 422 },
    )
  }

  if (isAppError(error)) {
    return NextResponse.json(error.toJSON(), { status: error.status })
  }

  // An unexpected failure is logged with its detail and answered without it.
  console.error('[api] unhandled', error)
  return NextResponse.json(
    { error: { code: 'INTERNAL', message: 'Something went wrong.' } },
    { status: 500 },
  )
}

export function csvResponse(body: string, fileName: string): NextResponse {
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  })
}
