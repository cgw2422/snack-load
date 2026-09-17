import type { Prisma } from '@/generated/prisma/client'
import { ROLE_DEFINITIONS, ROLE_KEYS, type RoleKey } from '@/lib/permissions'

/**
 * Everything a brand-new organization needs before anyone can log into it.
 * Run inside the caller's transaction so a half-provisioned company cannot exist.
 */

export const DOCUMENT_SEQUENCES: { docType: string; prefix: string; padTo: number; start: number }[] = [
  { docType: 'SALE', prefix: 'S-', padTo: 5, start: 1001 },
  { docType: 'RECEIPT', prefix: 'R-', padTo: 5, start: 10001 },
  { docType: 'RETURN', prefix: 'RT-', padTo: 5, start: 1 },
  { docType: 'CREDIT_MEMO', prefix: 'CM-', padTo: 5, start: 1 },
  { docType: 'REFUND', prefix: 'RF-', padTo: 5, start: 1 },
  { docType: 'RECEIVING', prefix: 'RCV-', padTo: 5, start: 1 },
  { docType: 'TRUCK_LOAD', prefix: 'TL-', padTo: 5, start: 1 },
  { docType: 'PAYMENT', prefix: 'P-', padTo: 5, start: 1 },
  { docType: 'CUSTOMER', prefix: '', padTo: 4, start: 1001 },
]

export async function seedRoles(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<Record<RoleKey, string>> {
  const ids = {} as Record<RoleKey, string>

  for (const key of ROLE_KEYS) {
    const def = ROLE_DEFINITIONS[key]
    const role = await tx.role.create({
      data: {
        organizationId,
        key,
        name: def.name,
        description: def.description,
        isSystem: true,
        permissions: { create: def.permissions.map((permission) => ({ permission })) },
      },
      select: { id: true },
    })
    ids[key] = role.id
  }

  return ids
}

export async function seedDocumentSequences(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  await tx.documentSequence.createMany({
    data: DOCUMENT_SEQUENCES.map((s) => ({
      organizationId,
      docType: s.docType,
      prefix: s.prefix,
      padTo: s.padTo,
      nextNumber: s.start,
    })),
  })
}

/** Every distributor has somewhere to put stock, even the one-truck owner/operator. */
export async function seedPrimaryWarehouse(
  tx: Prisma.TransactionClient,
  organizationId: string,
  name = 'Main Warehouse',
): Promise<{ warehouseId: string; locationId: string }> {
  const location = await tx.inventoryLocation.create({
    data: { organizationId, kind: 'WAREHOUSE', name, code: 'WH1' },
    select: { id: true },
  })
  const warehouse = await tx.warehouse.create({
    data: { organizationId, locationId: location.id, isPrimary: true },
    select: { id: true },
  })
  return { warehouseId: warehouse.id, locationId: location.id }
}

export const ONBOARDING_STEPS = [
  'company',
  'products',
  'customers',
  'team',
  'vehicles',
  'routes',
  'inventory',
  'quickbooks',
  'first_route',
] as const

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export const ONBOARDING_LABELS: Record<OnboardingStep, { title: string; description: string; href: string; optional?: boolean }> = {
  company: { title: 'Company information', description: 'Name, address and receipt details.', href: '/settings/company' },
  products: { title: 'Add or import products', description: 'Bring in your catalog from a spreadsheet.', href: '/inventory/products' },
  customers: { title: 'Add or import stores', description: 'Your gas stations, markets and convenience stores.', href: '/customers' },
  team: { title: 'Add route runners', description: 'Invite the drivers who will run your routes.', href: '/team' },
  vehicles: { title: 'Add trucks', description: 'Each truck carries its own inventory.', href: '/vehicles' },
  routes: { title: 'Create routes', description: 'Group stores into the days you service them.', href: '/routes/plan' },
  inventory: { title: 'Set starting inventory', description: 'Receive what is already on your shelves.', href: '/inventory/receive' },
  quickbooks: { title: 'Connect QuickBooks', description: 'Optional — sync invoices and payments.', href: '/settings/integrations', optional: true },
  first_route: { title: 'Run your first route', description: 'Load a truck and head out.', href: '/routes' },
}

export function emptyOnboarding(): Record<string, boolean> {
  return Object.fromEntries(ONBOARDING_STEPS.map((s) => [s, false]))
}
