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

/**
 * A generated document. `attachment` makes the browser save it; inline lets the
 * viewer render it in place, which is what the share sheet's preview wants.
 */
export function fileResponse(
  body: Uint8Array,
  fileName: string,
  contentType: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): NextResponse {
  return new NextResponse(body as BodyInit, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `${disposition}; filename="${fileName}"`,
      'Content-Length': String(body.byteLength),
      // Receipts carry customer data and can be voided after the fact; a cached
      // copy in a shared proxy is not worth the convenience.
      'Cache-Control': 'private, no-store',
    },
  })
}

/**
 * A read the phone is allowed to keep a copy of (docs/05 §2).
 *
 * `no-store` is not a contradiction. It keeps the response out of every cache
 * that decides for itself what to keep — the browser's HTTP cache, a CDN, a
 * corporate proxy — because this is one tenant's data and none of them can tell
 * two runners apart. The only copy kept is the one the service worker puts
 * there deliberately, in a cache named for the signed-in user and emptied when
 * they sign out.
 */
export function snapshotResponse(body: { asOf: string }): NextResponse {
  return NextResponse.json(body, {
    headers: {
      'Cache-Control': 'private, no-store',
      /** Lets the service worker label a cached figure without parsing it. */
      'X-Snapshot-As-Of': body.asOf,
    },
  })
}
