import { cookies, headers } from 'next/headers'
import { cache } from 'react'
import { unsafeDb } from '@/server/db/client'
import { forbidden, unauthenticated } from '@/lib/errors'
import type { Permission } from '@/lib/permissions'
import { SESSION_COOKIE, resolveSessionToken } from './session'

/**
 * AuthContext (docs/03 §1).
 *
 * Every service function takes this as its first argument. It is always derived
 * from the session and never from the request body — which is why a service
 * cannot be tricked into operating on another organization by a crafted payload.
 */
export type AuthContext = {
  userId: string
  organizationId: string
  membershipId: string
  roleKey: string
  roleName: string
  permissions: ReadonlySet<Permission>
  sessionId: string
  user: { id: string; firstName: string; lastName: string; email: string }
  organization: { id: string; name: string; slug: string; currency: string; timezone: string }
}

export async function buildContextFromToken(token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null

  const resolved = await resolveSessionToken(token)
  if (!resolved) return null

  const membership = await unsafeDb.membership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: resolved.organizationId,
        userId: resolved.userId,
      },
    },
    select: {
      id: true,
      status: true,
      role: {
        select: { key: true, name: true, permissions: { select: { permission: true } } },
      },
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
      organization: { select: { id: true, name: true, slug: true, currency: true, timezone: true } },
    },
  })

  // A revoked membership must not keep working just because the session row lives on.
  if (!membership || membership.status !== 'ACTIVE') return null

  return {
    userId: resolved.userId,
    organizationId: resolved.organizationId,
    membershipId: membership.id,
    roleKey: membership.role.key,
    roleName: membership.role.name,
    permissions: new Set(membership.role.permissions.map((p) => p.permission as Permission)),
    sessionId: resolved.sessionId,
    user: membership.user,
    organization: membership.organization,
  }
}

/**
 * Reads the credential from either carrier: Bearer first (native/API), then the
 * cookie (web). Memoized per request so a page with a dozen server components
 * resolves the session once.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const headerList = await headers()
  const authorization = headerList.get('authorization')

  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const ctx = await buildContextFromToken(authorization.slice(7).trim())
    if (ctx) return ctx
  }

  const cookieStore = await cookies()
  return buildContextFromToken(cookieStore.get(SESSION_COOKIE)?.value)
})

export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuthContext()
  if (!ctx) throw unauthenticated()
  return ctx
}

export function can(ctx: AuthContext, permission: Permission): boolean {
  return ctx.permissions.has(permission)
}

/** True if the actor holds either the org-wide permission or its `_own` variant. */
export function canAny(ctx: AuthContext, ...permissions: Permission[]): boolean {
  return permissions.some((p) => ctx.permissions.has(p))
}

export function requirePermission(ctx: AuthContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) {
    throw forbidden(`This action requires the "${permission}" permission.`)
  }
}

export async function requirePermissionPage(permission: Permission): Promise<AuthContext> {
  const ctx = await requireAuth()
  requirePermission(ctx, permission)
  return ctx
}
