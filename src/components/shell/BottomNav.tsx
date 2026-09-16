'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/cn'
import { isActivePath, type NavItem } from '@/lib/navigation'
import { NavIcon } from './NavIcon'

/**
 * The phone's primary navigation (spec §44).
 *
 * SELL is raised and orange because it is the action the job is built around —
 * someone standing in a gas station reaching for it one-handed. The bar itself
 * reserves the iOS home-indicator inset so nothing sits under the swipe area.
 */
export function BottomNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-[var(--nav-bg)]/95 backdrop-blur-lg md:hidden safe-bottom"
    >
      <ul className="mx-auto flex max-w-lg items-end justify-around px-2 pt-1.5 pb-1">
        {items.map((item) => {
          const active = isActivePath(pathname, item.href)
          const emphasized = item.icon === 'plus'

          if (emphasized) {
            return (
              <li key={item.href} className="relative -mt-6">
                <Link
                  href={item.href}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex size-touch-lg flex-col items-center justify-center rounded-full',
                    'bg-flame-500 text-white shadow-lg shadow-flame-500/30',
                    'transition-transform active:scale-95',
                    active && 'ring-4 ring-flame-500/25',
                  )}
                >
                  <NavIcon name={item.icon} className="size-7" strokeWidth={2.6} />
                </Link>
                <span className="mt-0.5 block text-center text-[10px] font-semibold text-flame-600">
                  {item.label}
                </span>
              </li>
            )
          }

          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-touch flex-col items-center justify-center gap-0.5 rounded-lg py-1',
                  'transition-colors active:bg-surface-sunken',
                  active ? 'text-navy-700 dark:text-white' : 'text-ink-subtle',
                )}
              >
                <NavIcon
                  name={item.icon}
                  className="size-6"
                  strokeWidth={active ? 2.5 : 2}
                />
                <span className={cn('text-[10px]', active ? 'font-bold' : 'font-medium')}>
                  {item.label}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
