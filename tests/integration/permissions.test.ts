import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { can, requirePermission } from '@/server/auth/context'
import { PERMISSIONS, ROLE_DEFINITIONS, ROLE_KEYS, isPermission } from '@/lib/permissions'
import { changeMemberRole, listTeam, setMemberStatus } from '@/server/services/user.service'
import { inviteMember } from '@/server/services/auth.service'
import { PRIMARY_NAV, MORE_NAV, visibleItems } from '@/lib/navigation'
import { addMember, createTestOrg, uniqueEmail, type TestOrg } from '../helpers'

describe('permission model', () => {
  it('has no role granting a permission that does not exist', () => {
    for (const key of ROLE_KEYS) {
      for (const permission of ROLE_DEFINITIONS[key].permissions) {
        expect(isPermission(permission)).toBe(true)
      }
    }
  })

  it('gives an owner everything', () => {
    expect(ROLE_DEFINITIONS.owner.permissions).toHaveLength(PERMISSIONS.length)
  })

  it('keeps role management away from admins', () => {
    expect(ROLE_DEFINITIONS.admin.permissions).not.toContain('role:manage')
    expect(ROLE_DEFINITIONS.owner.permissions).toContain('role:manage')
  })

  it('scopes a runner to their own work', () => {
    const runner = new Set(ROLE_DEFINITIONS.runner.permissions)
    expect(runner.has('route:read_own')).toBe(true)
    expect(runner.has('route:read')).toBe(false)
    expect(runner.has('sale:read_own')).toBe(true)
    expect(runner.has('sale:read')).toBe(false)
    // A driver should not be able to void a sale or see the audit log.
    expect(runner.has('sale:void')).toBe(false)
    expect(runner.has('audit:read')).toBe(false)
    expect(runner.has('report:financial')).toBe(false)
  })

  it('keeps warehouse staff out of the money', () => {
    const warehouse = new Set(ROLE_DEFINITIONS.warehouse.permissions)
    expect(warehouse.has('inventory:receive')).toBe(true)
    expect(warehouse.has('inventory:load_truck')).toBe(true)
    expect(warehouse.has('payment:create')).toBe(false)
    expect(warehouse.has('report:financial')).toBe(false)
  })

  it('keeps office staff out of inventory posting', () => {
    const office = new Set(ROLE_DEFINITIONS.office.permissions)
    expect(office.has('payment:allocate')).toBe(true)
    expect(office.has('report:financial')).toBe(true)
    expect(office.has('inventory:adjust')).toBe(false)
    expect(office.has('inventory:receive')).toBe(false)
  })
})

describe('navigation follows permissions, not roles', () => {
  it('shows a runner the selling tabs and hides the office ones', () => {
    const runner = new Set<string>(ROLE_DEFINITIONS.runner.permissions)
    const primary = visibleItems(PRIMARY_NAV, runner).map((i) => i.href)
    expect(primary).toEqual(['/', '/routes', '/sell', '/inventory', '/more'])

    const more = visibleItems(MORE_NAV, runner).map((i) => i.href)
    expect(more).not.toContain('/reports')
    expect(more).not.toContain('/receivables')
    expect(more).not.toContain('/team')
  })

  it('shows an owner everything', () => {
    const owner = new Set<string>(ROLE_DEFINITIONS.owner.permissions)
    expect(visibleItems(MORE_NAV, owner)).toHaveLength(MORE_NAV.length)
  })

  it('hides Sell from warehouse staff, who do not sell', () => {
    const warehouse = new Set<string>(ROLE_DEFINITIONS.warehouse.permissions)
    expect(visibleItems(PRIMARY_NAV, warehouse).map((i) => i.href)).not.toContain('/sell')
  })
})

describe('services enforce permissions server-side', () => {
  let org: TestOrg
  let runnerCtx: Awaited<ReturnType<typeof addMember>>

  beforeAll(async () => {
    org = await createTestOrg()
    runnerCtx = await addMember(org, 'runner')
  })

  afterAll(async () => {
    await unsafeDb.organization.delete({ where: { id: org.organizationId } })
  })

  it('stops a runner reading the team list', async () => {
    await expect(listTeam(runnerCtx.ctx)).rejects.toThrow(/permission/i)
  })

  it('stops a runner inviting people', async () => {
    await expect(
      inviteMember(runnerCtx.ctx, { email: uniqueEmail('x'), roleKey: 'owner' }),
    ).rejects.toThrow(/permission/i)
  })

  it('stops a runner suspending a colleague', async () => {
    await expect(
      setMemberStatus(runnerCtx.ctx, org.ownerCtx.membershipId, 'SUSPENDED'),
    ).rejects.toThrow(/permission/i)
  })

  it('lets an owner do all of it', async () => {
    const team = await listTeam(org.ownerCtx)
    expect(team.members.length).toBe(2)
    expect(team.members.some((m) => m.isSelf)).toBe(true)
  })

  it('will not let the last owner be suspended', async () => {
    const admin = await addMember(org, 'admin')
    await expect(
      setMemberStatus(admin.ctx, org.ownerCtx.membershipId, 'SUSPENDED'),
    ).rejects.toThrow(/at least one active owner/i)
  })

  it('will not let the last owner be demoted', async () => {
    await expect(
      changeMemberRole(org.ownerCtx, org.ownerCtx.membershipId, 'runner'),
    ).rejects.toThrow(/at least one active owner/i)
  })

  it('will not let someone change their own access', async () => {
    await expect(
      setMemberStatus(org.ownerCtx, org.ownerCtx.membershipId, 'SUSPENDED'),
    ).rejects.toThrow(/your own access/i)
  })

  it('reports a missing permission by name, so the fix is obvious', () => {
    expect(can(runnerCtx.ctx, 'sale:create')).toBe(true)
    expect(can(runnerCtx.ctx, 'sale:void')).toBe(false)
    expect(() => requirePermission(runnerCtx.ctx, 'sale:void')).toThrow(/"sale:void"/)
  })
})
