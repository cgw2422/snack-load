import type { Permission } from './permissions'

/**
 * Navigation (spec §44).
 *
 * Mobile gets five bottom targets with SELL raised in the centre; desktop gets a
 * sidebar with the same destinations plus the admin work that belongs on a big
 * screen. Items are filtered by permission, so a runner never sees a tab that
 * would bounce them.
 */

export type NavItem = {
  href: string
  label: string
  icon: IconName
  /** Any one of these grants the item. Omitted means everyone signed in. */
  anyOf?: Permission[]
  description?: string
}

export type IconName =
  | 'home' | 'route' | 'plus' | 'boxes' | 'menu'
  | 'store' | 'chart' | 'users' | 'truck' | 'factory' | 'settings'
  | 'receipt' | 'wallet' | 'upload'

export const PRIMARY_NAV: NavItem[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/routes', label: 'Routes', icon: 'route', anyOf: ['route:read', 'route:read_own'] },
  { href: '/sell', label: 'Sell', icon: 'plus', anyOf: ['sale:create'] },
  { href: '/inventory', label: 'Inventory', icon: 'boxes', anyOf: ['inventory:read'] },
  { href: '/more', label: 'More', icon: 'menu' },
]

export const MORE_NAV: NavItem[] = [
  {
    href: '/customers',
    label: 'Customers',
    icon: 'store',
    anyOf: ['customer:read'],
    description: 'Stores, balances and history',
  },
  {
    href: '/receipts',
    label: 'Receipts',
    icon: 'receipt',
    anyOf: ['receipt:read'],
    description: 'Every sale document',
  },
  {
    href: '/receivables',
    label: 'Receivables',
    icon: 'wallet',
    anyOf: ['payment:read'],
    description: 'What stores owe you',
  },
  {
    href: '/reports',
    label: 'Reports',
    icon: 'chart',
    anyOf: ['report:read'],
    description: 'Sales, profit, routes and stock',
  },
  {
    href: '/team',
    label: 'Team',
    icon: 'users',
    anyOf: ['user:read'],
    description: 'Runners, warehouse and office staff',
  },
  {
    href: '/vehicles',
    label: 'Trucks',
    icon: 'truck',
    anyOf: ['inventory:read'],
    description: 'Vehicles and what is on them',
  },
  {
    href: '/suppliers',
    label: 'Suppliers',
    icon: 'factory',
    anyOf: ['inventory:receive', 'product:create'],
    description: 'Who you buy from',
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: 'settings',
    anyOf: ['org:update'],
    description: 'Company, integrations and preferences',
  },
]

/** Desktop sidebar: the phone destinations plus the work that wants a big screen. */
export const DESKTOP_NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Operations',
    items: [
      { href: '/', label: 'Dashboard', icon: 'home' },
      { href: '/routes', label: 'Routes', icon: 'route', anyOf: ['route:read', 'route:read_own'] },
      { href: '/sell', label: 'New sale', icon: 'plus', anyOf: ['sale:create'] },
      { href: '/inventory', label: 'Inventory', icon: 'boxes', anyOf: ['inventory:read'] },
      { href: '/vehicles', label: 'Trucks', icon: 'truck', anyOf: ['inventory:read'] },
    ],
  },
  {
    heading: 'Accounts',
    items: [
      { href: '/customers', label: 'Customers', icon: 'store', anyOf: ['customer:read'] },
      { href: '/receipts', label: 'Receipts', icon: 'receipt', anyOf: ['receipt:read'] },
      { href: '/receivables', label: 'Receivables', icon: 'wallet', anyOf: ['payment:read'] },
      {
        href: '/suppliers',
        label: 'Suppliers',
        icon: 'factory',
        anyOf: ['inventory:receive', 'product:create'],
      },
    ],
  },
  {
    heading: 'Insight',
    items: [{ href: '/reports', label: 'Reports', icon: 'chart', anyOf: ['report:read'] }],
  },
  {
    heading: 'Company',
    items: [
      { href: '/team', label: 'Team', icon: 'users', anyOf: ['user:read'] },
      { href: '/settings', label: 'Settings', icon: 'settings', anyOf: ['org:update'] },
    ],
  },
]

export function visibleItems(items: NavItem[], permissions: ReadonlySet<string>): NavItem[] {
  return items.filter((item) => !item.anyOf || item.anyOf.some((p) => permissions.has(p)))
}

export function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}
