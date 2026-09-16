import { createHash, randomBytes } from 'node:crypto'
import { unsafeDb } from '@/server/db/client'
import type { SessionClient } from '@/generated/prisma/enums'

/**
 * Sessions (docs/04 §2).
 *
 * One opaque token, two carriers: an httpOnly cookie for the browser, an
 * `Authorization: Bearer` header for the future native app. That single decision
 * is what lets React Native reuse this backend without an auth rewrite.
 *
 * The raw token is returned to the caller exactly once and never persisted —
 * only sha256(token) is stored, so a leaked database cannot be used to log in.
 */

export const SESSION_COOKIE = 'snackload_session'
export const SESSION_TTL_DAYS = 30
const TOKEN_BYTES = 32
/** Sliding expiry is written at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

export type CreatedSession = {
  /** Show this to the client once. It cannot be recovered afterwards. */
  token: string
  sessionId: string
  expiresAt: Date
}

export async function createSession(params: {
  userId: string
  organizationId: string
  client?: SessionClient
  userAgent?: string | null
  ipAddress?: string | null
}): Promise<CreatedSession> {
  const token = mintToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)

  const session = await unsafeDb.session.create({
    data: {
      userId: params.userId,
      organizationId: params.organizationId,
      tokenHash: hashToken(token),
      client: params.client ?? 'WEB',
      userAgent: params.userAgent?.slice(0, 500) ?? null,
      ipAddress: params.ipAddress ?? null,
      expiresAt,
    },
    select: { id: true },
  })

  return { token, sessionId: session.id, expiresAt }
}

export type ResolvedSession = {
  sessionId: string
  userId: string
  organizationId: string
}

export async function resolveSessionToken(token: string): Promise<ResolvedSession | null> {
  if (!token) return null

  const session = await unsafeDb.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true, userId: true, organizationId: true,
      expiresAt: true, revokedAt: true, lastUsedAt: true,
      user: { select: { status: true } },
      organization: { select: { status: true } },
    },
  })

  if (!session) return null
  if (session.revokedAt) return null
  if (session.expiresAt.getTime() <= Date.now()) return null
  if (session.user.status !== 'ACTIVE') return null
  if (session.organization.status !== 'ACTIVE') return null

  if (Date.now() - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await unsafeDb.session.update({
      where: { id: session.id },
      data: {
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    })
  }

  return { sessionId: session.id, userId: session.userId, organizationId: session.organizationId }
}

export async function revokeSession(sessionId: string): Promise<void> {
  await unsafeDb.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** Used on password change: every other device is signed out. */
export async function revokeAllUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
  await unsafeDb.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  })
}

export function sessionCookieOptions(expiresAt: Date, secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  }
}
