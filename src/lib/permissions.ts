/**
 * Permissions (docs/04 §3).
 *
 * Call sites ask for a permission string. Nothing in this codebase branches on a
 * role name — which is why a custom role in V2 is an INSERT and a few checkboxes
 * rather than a change to 200 call sites.
 */

export const PERMISSIONS = [
  'org:read', 'org:update', 'org:manage_integrations',
  'user:read', 'user:invite', 'user:update', 'user:deactivate', 'role:manage',
  'product:read', 'product:create', 'product:update', 'product:deactivate', 'product:import',
  'price:read', 'price:override',
  'customer:read', 'customer:create', 'customer:update', 'customer:deactivate', 'customer:import',
  'inventory:read', 'inventory:receive', 'inventory:adjust', 'inventory:transfer',
  'inventory:load_truck', 'inventory:unload_truck',
  'route:read', 'route:read_own', 'route:create', 'route:update', 'route:assign', 'route:optimize',
  'routerun:start', 'routerun:complete', 'routerun:closeout', 'routerun:closeout_approve',
  'sale:read', 'sale:read_own', 'sale:create', 'sale:discount', 'sale:void',
  'payment:read', 'payment:create', 'payment:allocate', 'payment:void',
  'return:create', 'return:approve',
  'receipt:read', 'receipt:send',
  'report:read', 'report:financial', 'report:export',
  'audit:read',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS)

export type RoleKey = 'owner' | 'admin' | 'runner' | 'warehouse' | 'office'

/**
 * A runner holds `route:read_own` and `sale:read_own`; an owner holds the
 * unscoped `route:read` / `sale:read`. Services inspect which of the pair is
 * present and NARROW THE QUERY — scoping is part of the `where` clause, never a
 * filter applied after fetching (docs/04 §3).
 */
const ADMIN_PERMISSIONS: Permission[] = PERMISSIONS.filter(
  (p) => p !== 'role:manage',
) as Permission[]

const RUNNER_PERMISSIONS: Permission[] = [
  'org:read',
  'product:read', 'price:read',
  'customer:read', 'customer:update',
  'inventory:read',
  'route:read_own',
  'routerun:start', 'routerun:complete', 'routerun:closeout',
  'sale:read_own', 'sale:create',
  'payment:create',
  'return:create',
  'receipt:read', 'receipt:send',
]

const WAREHOUSE_PERMISSIONS: Permission[] = [
  'org:read',
  'product:read', 'product:create', 'product:update', 'product:import',
  'inventory:read', 'inventory:receive', 'inventory:adjust', 'inventory:transfer',
  'inventory:load_truck', 'inventory:unload_truck',
  'route:read',
  'customer:read',
  'report:read', 'report:export',
]

const OFFICE_PERMISSIONS: Permission[] = [
  'org:read', 'org:manage_integrations',
  'user:read',
  'product:read', 'product:update', 'product:import',
  'price:read', 'price:override',
  'customer:read', 'customer:create', 'customer:update', 'customer:deactivate', 'customer:import',
  'inventory:read',
  'route:read', 'route:create', 'route:update', 'route:assign',
  'routerun:closeout_approve',
  'sale:read', 'sale:void',
  'payment:read', 'payment:create', 'payment:allocate', 'payment:void',
  'return:create', 'return:approve',
  'receipt:read', 'receipt:send',
  'report:read', 'report:financial', 'report:export',
  'audit:read',
]

export const ROLE_DEFINITIONS: Record<
  RoleKey,
  { name: string; description: string; permissions: readonly Permission[] }
> = {
  owner: {
    name: 'Owner',
    description: 'Full access, including team, roles, integrations and all financials.',
    permissions: PERMISSIONS,
  },
  admin: {
    name: 'Admin',
    description: 'Everything an owner can do except managing roles.',
    permissions: ADMIN_PERMISSIONS,
  },
  runner: {
    name: 'Route Runner',
    description: 'Runs assigned routes, sells at the store, takes payment, closes out.',
    permissions: RUNNER_PERMISSIONS,
  },
  warehouse: {
    name: 'Warehouse',
    description: 'Receives stock, adjusts and transfers inventory, loads and unloads trucks.',
    permissions: WAREHOUSE_PERMISSIONS,
  },
  office: {
    name: 'Office / Accounting',
    description: 'Customers, receivables, payments, reports and the QuickBooks connection.',
    permissions: OFFICE_PERMISSIONS,
  },
}

export const ROLE_KEYS = Object.keys(ROLE_DEFINITIONS) as RoleKey[]

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value)
}
