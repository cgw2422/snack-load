import { createHash, randomBytes } from 'node:crypto'
import { unsafeDb } from '@/server/db/client'
import { AppError, conflict, notFound } from '@/lib/errors'
import { uniqueSlug } from '@/lib/slug'
import { ROLE_DEFINITIONS, type RoleKey } from '@/lib/permissions'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { burnTimeOnUnknownUser, hashPassword, verifyPassword } from '@/server/auth/password'
import { createSession, revokeAllUserSessions, type CreatedSession } from '@/server/auth/session'
import type { AcceptInviteInput, InviteInput, LoginInput, RegisterInput } from '@/lib/schemas/auth'
import {
  emptyOnboarding,
  seedDocumentSequences,
  seedPrimaryWarehouse,
  seedRoles,
} from './provisioning'

/**
 * Authentication and team membership.
 *
 * This is one of the three services permitted to use the unscoped client
 * (docs/04 §5): it runs before an organization is known, or it creates one.
 */

const MAX_FAILED_LOGINS = 8
const LOCKOUT_MS = 15 * 60 * 1000

export type SessionResult = CreatedSession & {
  userId: string
  organizationId: string
}

/** Registration creates the company, its roles, its warehouse and its first owner atomically. */
export async function registerOrganization(
  input: RegisterInput,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {},
): Promise<SessionResult> {
  const existing = await unsafeDb.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  })
  if (existing) {
    throw conflict('An account with that email already exists. Sign in instead.')
  }

  const slug = await uniqueSlug(input.companyName, async (candidate) => {
    const hit = await unsafeDb.organization.findUnique({
      where: { slug: candidate },
      select: { id: true },
    })
    return hit !== null
  })

  const passwordHash = await hashPassword(input.password)

  const { userId, organizationId } = await unsafeDb.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: input.companyName,
        slug,
        phone: input.phone || null,
        email: input.email,
        onboardingJson: emptyOnboarding(),
      },
      select: { id: true },
    })

    const roleIds = await seedRoles(tx, organization.id)
    await seedDocumentSequences(tx, organization.id)
    await seedPrimaryWarehouse(tx, organization.id)

    await tx.taxRate.create({
      data: { organizationId: organization.id, name: 'Default', rate: '0', isDefault: true },
    })

    const user = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone || null,
      },
      select: { id: true },
    })

    await tx.membership.create({
      data: { organizationId: organization.id, userId: user.id, roleId: roleIds.owner },
    })

    await tx.auditLog.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        action: 'organization.created',
        entityType: 'Organization',
        entityId: organization.id,
        afterJson: { name: input.companyName, slug },
      },
    })

    return { userId: user.id, organizationId: organization.id }
  })

  const session = await createSession({ userId, organizationId, ...meta })
  return { ...session, userId, organizationId }
}

export async function login(
  input: LoginInput,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {},
): Promise<SessionResult> {
  const user = await unsafeDb.user.findUnique({
    where: { email: input.email },
    select: {
      id: true, passwordHash: true, status: true,
      failedLoginCount: true, lockedUntil: true,
      memberships: {
        where: { status: 'ACTIVE' },
        select: { organizationId: true, organization: { select: { status: true } } },
        orderBy: { joinedAt: 'asc' },
      },
    },
  })

  // Spend the same time on an unknown email as on a known one, so response
  // timing does not reveal which accounts exist.
  if (!user) {
    await burnTimeOnUnknownUser(input.password)
    throw new AppError('UNAUTHENTICATED', 'That email or password is not correct.')
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new AppError(
      'RATE_LIMITED',
      'Too many failed attempts. Try again in a few minutes.',
    )
  }

  const ok = await verifyPassword(input.password, user.passwordHash)

  if (!ok) {
    const failed = user.failedLoginCount + 1
    await unsafeDb.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null,
      },
    })
    throw new AppError('UNAUTHENTICATED', 'That email or password is not correct.')
  }

  if (user.status !== 'ACTIVE') {
    throw new AppError('FORBIDDEN', 'This account has been disabled.')
  }

  const membership = user.memberships.find((mm) => mm.organization.status === 'ACTIVE')
  if (!membership) {
    throw new AppError('FORBIDDEN', 'This account is not active in any company.')
  }

  await unsafeDb.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })

  const session = await createSession({
    userId: user.id,
    organizationId: membership.organizationId,
    ...meta,
  })
  return { ...session, userId: user.id, organizationId: membership.organizationId }
}

const INVITE_TTL_DAYS = 14

export async function inviteMember(
  ctx: AuthContext,
  input: InviteInput,
): Promise<{ invitationId: string; token: string; acceptUrl: string }> {
  requirePermission(ctx, 'user:invite')

  const role = await unsafeDb.role.findUnique({
    where: { organizationId_key: { organizationId: ctx.organizationId, key: input.roleKey } },
    select: { id: true },
  })
  if (!role) throw notFound(`Role "${input.roleKey}"`)

  const existingUser = await unsafeDb.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  })
  if (existingUser) {
    const alreadyIn = await unsafeDb.membership.findUnique({
      where: {
        organizationId_userId: { organizationId: ctx.organizationId, userId: existingUser.id },
      },
      select: { id: true, status: true },
    })
    if (alreadyIn && alreadyIn.status === 'ACTIVE') {
      throw conflict('That person is already on your team.')
    }
  }

  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')

  // Supersede any outstanding invite for the same address rather than stacking them.
  await unsafeDb.invitation.updateMany({
    where: { organizationId: ctx.organizationId, email: input.email, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  const invitation = await unsafeDb.invitation.create({
    data: {
      organizationId: ctx.organizationId,
      email: input.email,
      roleId: role.id,
      tokenHash,
      invitedByUserId: ctx.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  })

  await unsafeDb.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'invitation.sent',
      entityType: 'Invitation',
      entityId: invitation.id,
      afterJson: { email: input.email, role: input.roleKey },
    },
  })

  return {
    invitationId: invitation.id,
    token,
    acceptUrl: `/accept-invite?token=${token}`,
  }
}

export type InvitationPreview = {
  email: string
  organizationName: string
  roleName: string
  userExists: boolean
}

export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const invitation = await unsafeDb.invitation.findUnique({
    where: { tokenHash },
    select: {
      email: true, expiresAt: true, acceptedAt: true, revokedAt: true,
      organization: { select: { name: true } },
      role: { select: { name: true } },
    },
  })

  if (!invitation || invitation.revokedAt) throw notFound('Invitation')
  if (invitation.acceptedAt) throw conflict('That invitation has already been used.')
  if (invitation.expiresAt.getTime() <= Date.now()) throw conflict('That invitation has expired.')

  const existing = await unsafeDb.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  })

  return {
    email: invitation.email,
    organizationName: invitation.organization.name,
    roleName: invitation.role.name,
    userExists: existing !== null,
  }
}

export async function acceptInvitation(
  input: AcceptInviteInput,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {},
): Promise<SessionResult> {
  const tokenHash = createHash('sha256').update(input.token).digest('hex')

  const invitation = await unsafeDb.invitation.findUnique({
    where: { tokenHash },
    select: {
      id: true, organizationId: true, email: true, roleId: true,
      expiresAt: true, acceptedAt: true, revokedAt: true,
    },
  })

  if (!invitation || invitation.revokedAt) throw notFound('Invitation')
  if (invitation.acceptedAt) throw conflict('That invitation has already been used.')
  if (invitation.expiresAt.getTime() <= Date.now()) throw conflict('That invitation has expired.')

  const passwordHash = await hashPassword(input.password)

  const userId = await unsafeDb.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    })

    const user = existing
      ? existing
      : await tx.user.create({
          data: {
            email: invitation.email,
            passwordHash,
            firstName: input.firstName,
            lastName: input.lastName,
          },
          select: { id: true },
        })

    await tx.membership.upsert({
      where: {
        organizationId_userId: { organizationId: invitation.organizationId, userId: user.id },
      },
      create: {
        organizationId: invitation.organizationId,
        userId: user.id,
        roleId: invitation.roleId,
      },
      update: { roleId: invitation.roleId, status: 'ACTIVE', removedAt: null },
    })

    // Claiming the invitation is conditional on it still being unclaimed, so two
    // simultaneous accepts cannot both succeed.
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date(), acceptedByUserId: user.id },
    })
    if (claimed.count === 0) throw conflict('That invitation has already been used.')

    await tx.auditLog.create({
      data: {
        organizationId: invitation.organizationId,
        userId: user.id,
        action: 'invitation.accepted',
        entityType: 'Invitation',
        entityId: invitation.id,
        afterJson: { email: invitation.email },
      },
    })

    return user.id
  })

  const session = await createSession({
    userId,
    organizationId: invitation.organizationId,
    ...meta,
  })
  return { ...session, userId, organizationId: invitation.organizationId }
}

export async function changePassword(
  ctx: AuthContext,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const user = await unsafeDb.user.findUnique({
    where: { id: ctx.userId },
    select: { passwordHash: true },
  })
  if (!user) throw notFound('User')

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new AppError('UNAUTHENTICATED', 'Your current password is not correct.')
  }

  await unsafeDb.user.update({
    where: { id: ctx.userId },
    data: { passwordHash: await hashPassword(input.newPassword) },
  })

  // Every other device is signed out; this one stays.
  await revokeAllUserSessions(ctx.userId, ctx.sessionId)

  await unsafeDb.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'user.password_changed',
      entityType: 'User',
      entityId: ctx.userId,
    },
  })
}

export function roleLabel(key: string): string {
  return ROLE_DEFINITIONS[key as RoleKey]?.name ?? key
}
