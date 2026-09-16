import { db } from '@/server/db/tenant'
import { unsafeDb } from '@/server/db/client'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'

/** Team membership: who is in the company, and what they may do. */

export type TeamMember = {
  membershipId: string
  userId: string
  name: string
  email: string
  phone: string | null
  roleKey: string
  roleName: string
  status: string
  isSelf: boolean
  lastLoginAt: string | null
  joinedAt: string
}

export type PendingInvite = {
  id: string
  email: string
  roleName: string
  expiresAt: string
  invitedByName: string
}

export async function listTeam(ctx: AuthContext): Promise<{
  members: TeamMember[]
  invites: PendingInvite[]
}> {
  requirePermission(ctx, 'user:read')
  const prisma = db(ctx)

  const [memberships, invitations] = await Promise.all([
    prisma.membership.findMany({
      where: { status: { not: 'REMOVED' } },
      select: {
        id: true,
        status: true,
        joinedAt: true,
        role: { select: { key: true, name: true } },
        user: {
          select: {
            id: true, firstName: true, lastName: true,
            email: true, phone: true, lastLoginAt: true,
          },
        },
      },
      orderBy: [{ role: { key: 'asc' } }, { joinedAt: 'asc' }],
    }),
    prisma.invitation.findMany({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        email: true,
        expiresAt: true,
        role: { select: { name: true } },
        invitedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return {
    members: memberships.map((mm) => ({
      membershipId: mm.id,
      userId: mm.user.id,
      name: `${mm.user.firstName} ${mm.user.lastName}`.trim(),
      email: mm.user.email,
      phone: mm.user.phone,
      roleKey: mm.role.key,
      roleName: mm.role.name,
      status: mm.status,
      isSelf: mm.user.id === ctx.userId,
      lastLoginAt: mm.user.lastLoginAt?.toISOString() ?? null,
      joinedAt: mm.joinedAt.toISOString(),
    })),
    invites: invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      roleName: inv.role.name,
      expiresAt: inv.expiresAt.toISOString(),
      invitedByName: `${inv.invitedBy.firstName} ${inv.invitedBy.lastName}`.trim(),
    })),
  }
}

export async function revokeInvitation(ctx: AuthContext, invitationId: string): Promise<void> {
  requirePermission(ctx, 'user:invite')
  const updated = await db(ctx).invitation.updateMany({
    where: { id: invitationId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  if (updated.count === 0) throw notFound('Invitation')
}

export async function setMemberStatus(
  ctx: AuthContext,
  membershipId: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<void> {
  requirePermission(ctx, 'user:deactivate')
  const prisma = db(ctx)

  const membership = await prisma.membership.findFirst({
    where: { id: membershipId },
    select: { id: true, userId: true, status: true, role: { select: { key: true } } },
  })
  if (!membership) throw notFound('Team member')

  if (membership.userId === ctx.userId) {
    throw conflict('You cannot change your own access.')
  }

  // A company must never end up with nobody who can administer it.
  if (membership.role.key === 'owner' && status !== 'ACTIVE') {
    const activeOwners = await prisma.membership.count({
      where: { status: 'ACTIVE', role: { key: 'owner' } },
    })
    if (activeOwners <= 1) throw conflict('Your company must keep at least one active owner.')
  }

  await prisma.membership.update({ where: { id: membership.id }, data: { status } })

  await prisma.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: status === 'ACTIVE' ? 'member.reactivated' : 'member.suspended',
      entityType: 'Membership',
      entityId: membership.id,
      beforeJson: { status: membership.status },
      afterJson: { status },
    },
  })

  // Suspension must take effect now, not whenever their session happens to expire.
  if (status !== 'ACTIVE') {
    await unsafeDb.session.updateMany({
      where: { userId: membership.userId, organizationId: ctx.organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }
}

export async function changeMemberRole(
  ctx: AuthContext,
  membershipId: string,
  roleKey: string,
): Promise<void> {
  requirePermission(ctx, 'role:manage')
  const prisma = db(ctx)

  const [membership, role] = await Promise.all([
    prisma.membership.findFirst({
      where: { id: membershipId },
      select: { id: true, userId: true, role: { select: { key: true } } },
    }),
    prisma.role.findFirst({ where: { key: roleKey }, select: { id: true, name: true } }),
  ])

  if (!membership) throw notFound('Team member')
  if (!role) throw notFound(`Role "${roleKey}"`)

  if (membership.role.key === 'owner' && roleKey !== 'owner') {
    const activeOwners = await prisma.membership.count({
      where: { status: 'ACTIVE', role: { key: 'owner' } },
    })
    if (activeOwners <= 1) throw conflict('Your company must keep at least one active owner.')
  }

  await prisma.membership.update({ where: { id: membership.id }, data: { roleId: role.id } })

  await prisma.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: 'member.role_changed',
      entityType: 'Membership',
      entityId: membership.id,
      beforeJson: { roleKey: membership.role.key },
      afterJson: { roleKey },
    },
  })
}
