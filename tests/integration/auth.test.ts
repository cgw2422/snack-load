import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { hashPassword, passwordProblems, verifyPassword } from '@/server/auth/password'
import { buildContextFromToken } from '@/server/auth/context'
import { createSession, hashToken, resolveSessionToken, revokeSession } from '@/server/auth/session'
import * as authService from '@/server/services/auth.service'
import { setMemberStatus } from '@/server/services/user.service'
import { addMember, uniqueEmail, type TestOrg } from '../helpers'
import { ROLE_DEFINITIONS } from '@/lib/permissions'

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery 9')
    expect(await verifyPassword('correct horse battery 9', hash)).toBe(true)
    expect(await verifyPassword('correct horse battery 8', hash)).toBe(false)
  })

  it('salts, so the same password never produces the same hash', async () => {
    expect(await hashPassword('same-password-1')).not.toBe(await hashPassword('same-password-1'))
  })

  it('carries its own parameters so the algorithm can be migrated later', async () => {
    expect(await hashPassword('parameters-1')).toMatch(/^scrypt\$16384\$8\$1\$/)
  })

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('anything', 'scrypt$x$y$z$q$r')).toBe(false)
  })

  it('states password requirements plainly', () => {
    expect(passwordProblems('short1')).toContain('Use at least 10 characters')
    expect(passwordProblems('abcdefghijkl')).toContain('Include at least one number')
    expect(passwordProblems('abcdefghij1')).toEqual([])
  })
})

describe('registration and login', () => {
  const orgIds: string[] = []
  const userIds: string[] = []

  afterAll(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: { in: orgIds } } })
    await unsafeDb.user.deleteMany({ where: { id: { in: userIds } } })
  })

  it('provisions a whole company on registration', async () => {
    const email = uniqueEmail('founder')
    const session = await authService.registerOrganization({
      companyName: 'Valley Snack Distributors',
      firstName: 'Cody',
      lastName: 'Whitaker',
      email,
      password: 'load-it-route-it-1',
    })
    orgIds.push(session.organizationId)
    userIds.push(session.userId)

    const [roles, sequences, warehouses, membership] = await Promise.all([
      unsafeDb.role.count({ where: { organizationId: session.organizationId } }),
      unsafeDb.documentSequence.count({ where: { organizationId: session.organizationId } }),
      unsafeDb.warehouse.count({ where: { organizationId: session.organizationId } }),
      unsafeDb.membership.findFirst({
        where: { organizationId: session.organizationId },
        select: { role: { select: { key: true } } },
      }),
    ])

    expect(roles).toBe(5)
    expect(sequences).toBeGreaterThan(0)
    expect(warehouses).toBe(1)
    expect(membership?.role.key).toBe('owner')
    expect(session.token).toBeTruthy()
  })

  it('gives every seeded role its documented permissions', async () => {
    const owner = await unsafeDb.role.findFirst({
      where: { organizationId: orgIds[0], key: 'runner' },
      select: { permissions: { select: { permission: true } } },
    })
    const granted = new Set(owner!.permissions.map((p) => p.permission))
    for (const permission of ROLE_DEFINITIONS.runner.permissions) {
      expect(granted.has(permission)).toBe(true)
    }
    // A runner must not be able to see the whole company's sales.
    expect(granted.has('sale:read')).toBe(false)
    expect(granted.has('sale:read_own')).toBe(true)
  })

  it('refuses a second company on the same email', async () => {
    const email = uniqueEmail('dup')
    const first = await authService.registerOrganization({
      companyName: 'First Co',
      firstName: 'A',
      lastName: 'B',
      email,
      password: 'load-it-route-it-1',
    })
    orgIds.push(first.organizationId)
    userIds.push(first.userId)

    await expect(
      authService.registerOrganization({
        companyName: 'Second Co',
        firstName: 'A',
        lastName: 'B',
        email,
        password: 'load-it-route-it-1',
      }),
    ).rejects.toThrow(/already exists/i)
  })

  it('gives two companies with the same name distinct slugs', async () => {
    const a = await authService.registerOrganization({
      companyName: 'Same Name Snacks',
      firstName: 'A', lastName: 'B', email: uniqueEmail('slug'), password: 'load-it-route-it-1',
    })
    const b = await authService.registerOrganization({
      companyName: 'Same Name Snacks',
      firstName: 'C', lastName: 'D', email: uniqueEmail('slug'), password: 'load-it-route-it-1',
    })
    orgIds.push(a.organizationId, b.organizationId)
    userIds.push(a.userId, b.userId)

    const slugs = await unsafeDb.organization.findMany({
      where: { id: { in: [a.organizationId, b.organizationId] } },
      select: { slug: true },
    })
    expect(new Set(slugs.map((s) => s.slug)).size).toBe(2)
  })

  it('signs a known user in and rejects a wrong password', async () => {
    const email = uniqueEmail('login')
    const registered = await authService.registerOrganization({
      companyName: 'Login Co', firstName: 'L', lastName: 'C', email, password: 'load-it-route-it-1',
    })
    orgIds.push(registered.organizationId)
    userIds.push(registered.userId)

    const session = await authService.login({ email, password: 'load-it-route-it-1' })
    expect(session.organizationId).toBe(registered.organizationId)

    await expect(authService.login({ email, password: 'wrong-password-1' })).rejects.toThrow(
      /not correct/i,
    )
  })

  it('gives the same answer for an unknown email as for a wrong password', async () => {
    await expect(
      authService.login({ email: uniqueEmail('ghost'), password: 'load-it-route-it-1' }),
    ).rejects.toThrow(/That email or password is not correct/)
  })

  it('locks an account after repeated failures', async () => {
    const email = uniqueEmail('lockout')
    const registered = await authService.registerOrganization({
      companyName: 'Lock Co', firstName: 'L', lastName: 'K', email, password: 'load-it-route-it-1',
    })
    orgIds.push(registered.organizationId)
    userIds.push(registered.userId)

    for (let i = 0; i < 8; i++) {
      await expect(authService.login({ email, password: 'nope-nope-1' })).rejects.toThrow()
    }
    // Even the correct password is refused while the lock holds.
    await expect(authService.login({ email, password: 'load-it-route-it-1' })).rejects.toThrow(
      /Too many failed attempts/i,
    )
  })
})

describe('sessions', () => {
  let org: TestOrg
  const orgIds: string[] = []

  beforeAll(async () => {
    const { createTestOrg } = await import('../helpers')
    org = await createTestOrg()
    orgIds.push(org.organizationId)
  })

  afterAll(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: { in: orgIds } } })
  })

  it('stores only the hash of the token', async () => {
    const session = await createSession({
      userId: org.ownerUserId,
      organizationId: org.organizationId,
    })
    const stored = await unsafeDb.session.findUnique({
      where: { id: session.sessionId },
      select: { tokenHash: true },
    })
    expect(stored?.tokenHash).toBe(hashToken(session.token))
    expect(stored?.tokenHash).not.toBe(session.token)
  })

  it('resolves a live token and refuses a revoked one', async () => {
    const session = await createSession({
      userId: org.ownerUserId,
      organizationId: org.organizationId,
    })
    expect(await resolveSessionToken(session.token)).toMatchObject({ userId: org.ownerUserId })

    await revokeSession(session.sessionId)
    expect(await resolveSessionToken(session.token)).toBeNull()
  })

  it('refuses an expired token', async () => {
    const session = await createSession({
      userId: org.ownerUserId,
      organizationId: org.organizationId,
    })
    await unsafeDb.session.update({
      where: { id: session.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect(await resolveSessionToken(session.token)).toBeNull()
  })

  it('refuses a made-up token', async () => {
    expect(await resolveSessionToken('not-a-real-token')).toBeNull()
    expect(await resolveSessionToken('')).toBeNull()
  })

  it('builds a context carrying the role\'s permissions', async () => {
    const session = await createSession({
      userId: org.ownerUserId,
      organizationId: org.organizationId,
    })
    const ctx = await buildContextFromToken(session.token)
    expect(ctx?.roleKey).toBe('owner')
    expect(ctx?.permissions.has('sale:void')).toBe(true)
    expect(ctx?.organizationId).toBe(org.organizationId)
  })

  it('stops working the moment the membership is suspended', async () => {
    const runner = await addMember(org, 'runner')
    const session = await createSession({
      userId: runner.userId,
      organizationId: org.organizationId,
    })
    expect(await buildContextFromToken(session.token)).not.toBeNull()

    await setMemberStatus(org.ownerCtx, runner.ctx.membershipId, 'SUSPENDED')

    // Suspension takes effect now, not whenever the session happens to expire.
    expect(await buildContextFromToken(session.token)).toBeNull()
  })
})

describe('invitations', () => {
  let org: TestOrg
  const orgIds: string[] = []
  const userIds: string[] = []

  beforeAll(async () => {
    const { createTestOrg } = await import('../helpers')
    org = await createTestOrg()
    orgIds.push(org.organizationId)
  })

  afterAll(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: { in: orgIds } } })
    await unsafeDb.user.deleteMany({ where: { id: { in: userIds } } })
  })

  it('invites someone and lets them join with the intended role', async () => {
    const email = uniqueEmail('invitee')
    const invite = await authService.inviteMember(org.ownerCtx, { email, roleKey: 'runner' })

    const preview = await authService.previewInvitation(invite.token)
    expect(preview.email).toBe(email)
    expect(preview.roleName).toBe('Route Runner')
    expect(preview.userExists).toBe(false)

    const session = await authService.acceptInvitation({
      token: invite.token,
      firstName: 'Mike',
      lastName: 'Donnelly',
      password: 'route-runner-pass-1',
    })
    userIds.push(session.userId)

    const membership = await unsafeDb.membership.findFirst({
      where: { organizationId: org.organizationId, userId: session.userId },
      select: { role: { select: { key: true } } },
    })
    expect(membership?.role.key).toBe('runner')
  })

  it('cannot be redeemed twice', async () => {
    const email = uniqueEmail('once')
    const invite = await authService.inviteMember(org.ownerCtx, { email, roleKey: 'office' })

    const session = await authService.acceptInvitation({
      token: invite.token, firstName: 'Pat', lastName: 'S', password: 'office-pass-1234',
    })
    userIds.push(session.userId)

    await expect(
      authService.acceptInvitation({
        token: invite.token, firstName: 'Someone', lastName: 'Else', password: 'other-pass-1234',
      }),
    ).rejects.toThrow(/already been used/i)
  })

  it('refuses an expired invitation', async () => {
    const invite = await authService.inviteMember(org.ownerCtx, {
      email: uniqueEmail('stale'),
      roleKey: 'warehouse',
    })
    await unsafeDb.invitation.update({
      where: { id: invite.invitationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expect(authService.previewInvitation(invite.token)).rejects.toThrow(/expired/i)
  })

  it('supersedes an outstanding invite rather than stacking them', async () => {
    const email = uniqueEmail('resend')
    await authService.inviteMember(org.ownerCtx, { email, roleKey: 'runner' })
    await authService.inviteMember(org.ownerCtx, { email, roleKey: 'office' })

    const live = await unsafeDb.invitation.count({
      where: { organizationId: org.organizationId, email, acceptedAt: null, revokedAt: null },
    })
    expect(live).toBe(1)
  })

  it('will not invite someone who is already on the team', async () => {
    const email = uniqueEmail('member')
    const invite = await authService.inviteMember(org.ownerCtx, { email, roleKey: 'runner' })
    const session = await authService.acceptInvitation({
      token: invite.token, firstName: 'A', lastName: 'B', password: 'already-here-1',
    })
    userIds.push(session.userId)

    await expect(
      authService.inviteMember(org.ownerCtx, { email, roleKey: 'runner' }),
    ).rejects.toThrow(/already on your team/i)
  })
})
