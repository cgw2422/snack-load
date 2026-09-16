import { randomUUID } from 'node:crypto'
import { unsafeDb } from '@/server/db/client'
import { hashPassword } from '@/server/auth/password'
import type { AuthContext } from '@/server/auth/context'
import { ROLE_DEFINITIONS, type Permission, type RoleKey } from '@/lib/permissions'
import {
  seedDocumentSequences,
  seedPrimaryWarehouse,
  seedRoles,
} from '@/server/services/provisioning'

/** A whole tenant, provisioned the way registration provisions one. */
export type TestOrg = {
  organizationId: string
  ownerUserId: string
  ownerCtx: AuthContext
  warehouseLocationId: string
  roleIds: Record<RoleKey, string>
}

let counter = 0
export const uniqueEmail = (prefix = 'user') => `${prefix}-${++counter}-${randomUUID()}@test.local`

export async function createTestOrg(name = `Org ${randomUUID().slice(0, 8)}`): Promise<TestOrg> {
  const passwordHash = await hashPassword('test-password-1')

  const organization = await unsafeDb.organization.create({
    data: { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 6)}` },
    select: { id: true },
  })

  const roleIds = await unsafeDb.$transaction(async (tx) => {
    const ids = await seedRoles(tx, organization.id)
    await seedDocumentSequences(tx, organization.id)
    return ids
  })

  const { locationId } = await seedPrimaryWarehouse(unsafeDb, organization.id)

  const owner = await unsafeDb.user.create({
    data: { email: uniqueEmail('owner'), passwordHash, firstName: 'Ada', lastName: 'Owner' },
    select: { id: true },
  })
  const membership = await unsafeDb.membership.create({
    data: { organizationId: organization.id, userId: owner.id, roleId: roleIds.owner },
    select: { id: true },
  })

  return {
    organizationId: organization.id,
    ownerUserId: owner.id,
    warehouseLocationId: locationId,
    roleIds,
    ownerCtx: buildCtx({
      organizationId: organization.id,
      userId: owner.id,
      membershipId: membership.id,
      roleKey: 'owner',
      organizationName: name,
    }),
  }
}

export function buildCtx(args: {
  organizationId: string
  userId: string
  membershipId: string
  roleKey: RoleKey
  organizationName?: string
  permissions?: Permission[]
}): AuthContext {
  return {
    userId: args.userId,
    organizationId: args.organizationId,
    membershipId: args.membershipId,
    roleKey: args.roleKey,
    roleName: ROLE_DEFINITIONS[args.roleKey].name,
    permissions: new Set(args.permissions ?? ROLE_DEFINITIONS[args.roleKey].permissions),
    sessionId: `session-${randomUUID()}`,
    user: { id: args.userId, firstName: 'Ada', lastName: 'Owner', email: 'ada@test.local' },
    organization: {
      id: args.organizationId,
      name: args.organizationName ?? 'Test Org',
      slug: `slug-${args.organizationId.slice(0, 6)}`,
      currency: 'USD',
      timezone: 'America/New_York',
    },
  }
}

export async function addMember(
  org: TestOrg,
  roleKey: RoleKey,
): Promise<{ userId: string; ctx: AuthContext }> {
  const user = await unsafeDb.user.create({
    data: {
      email: uniqueEmail(roleKey),
      passwordHash: await hashPassword('test-password-1'),
      firstName: 'Mike',
      lastName: 'Runner',
    },
    select: { id: true },
  })
  const membership = await unsafeDb.membership.create({
    data: { organizationId: org.organizationId, userId: user.id, roleId: org.roleIds[roleKey] },
    select: { id: true },
  })
  return {
    userId: user.id,
    ctx: buildCtx({
      organizationId: org.organizationId,
      userId: user.id,
      membershipId: membership.id,
      roleKey,
    }),
  }
}

/** A product with a base unit and a case, the shape everything else assumes. */
export async function createProduct(
  organizationId: string,
  options: {
    sku?: string
    name?: string
    unitsPerCase?: number
    costPerBaseUnit?: string
    casePrice?: string
    unitPrice?: string
    taxable?: boolean
    reorderPointBaseUnits?: number
  } = {},
) {
  const unitsPerCase = options.unitsPerCase ?? 12
  const product = await unsafeDb.product.create({
    data: {
      organizationId,
      sku: options.sku ?? `SKU-${randomUUID().slice(0, 8)}`,
      name: options.name ?? 'Takis Fuego',
      baseUomLabel: 'Bag',
      costPerBaseUnit: options.costPerBaseUnit ?? '1.200000',
      taxable: options.taxable ?? true,
      reorderPointBaseUnits: options.reorderPointBaseUnits ?? 0,
      uoms: {
        create: [
          {
            organizationId,
            code: 'EACH',
            label: 'Bag',
            baseUnitsPerUom: 1,
            price: options.unitPrice ?? '2.29',
            isBase: true,
          },
          {
            organizationId,
            code: 'CASE',
            label: 'Case',
            baseUnitsPerUom: unitsPerCase,
            price: options.casePrice ?? '19.50',
            isDefaultSaleUom: true,
          },
        ],
      },
    },
    select: { id: true, uoms: { select: { id: true, code: true, baseUnitsPerUom: true } } },
  })

  return {
    id: product.id,
    unitsPerCase,
    baseUomId: product.uoms.find((u) => u.code === 'EACH')!.id,
    caseUomId: product.uoms.find((u) => u.code === 'CASE')!.id,
  }
}

export async function createVehicleLocation(organizationId: string, truckNumber = '2') {
  const location = await unsafeDb.inventoryLocation.create({
    data: { organizationId, kind: 'VEHICLE', name: `Truck #${truckNumber}` },
    select: { id: true },
  })
  const vehicle = await unsafeDb.vehicle.create({
    data: {
      organizationId,
      locationId: location.id,
      name: `Truck #${truckNumber}`,
      truckNumber: `${truckNumber}-${randomUUID().slice(0, 4)}`,
    },
    select: { id: true },
  })
  return { vehicleId: vehicle.id, locationId: location.id }
}

export async function createCustomer(organizationId: string, name = "Joe's Marathon") {
  return unsafeDb.customer.create({
    data: {
      organizationId,
      accountNumber: `A-${randomUUID().slice(0, 8)}`,
      name,
      addressLine1: '123 Main St.',
      city: 'Riverton',
      state: 'OH',
      postalCode: '44870',
    },
    select: { id: true, name: true },
  })
}

export async function balanceOf(locationId: string, productId: string): Promise<number> {
  const row = await unsafeDb.inventoryBalance.findUnique({
    where: { locationId_productId: { locationId, productId } },
    select: { quantity: true },
  })
  return row?.quantity ?? 0
}

export async function avgCostOf(locationId: string, productId: string): Promise<string> {
  const row = await unsafeDb.inventoryBalance.findUnique({
    where: { locationId_productId: { locationId, productId } },
    select: { avgUnitCost: true },
  })
  return row?.avgUnitCost.toString() ?? '0'
}
