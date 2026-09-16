'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/cn'
import { SnackLoadWordmark } from '@/components/Brand'
import { isActivePath, type NavItem } from '@/lib/navigation'
import { NavIcon } from './NavIcon'

/**
 * Desktop navigation. Genuinely a different layout from the phone, not the
 * bottom bar stretched sideways (docs/05 §1).
 */
export function Sidebar({
  groups,
}: {
  groups: { heading: string; items: NavItem[] }[]
}) {
  const pathname = usePathname()

  return (
    <aside className="hidden w-64 shrink-0 border-r border-line bg-surface-raised md:flex md:flex-col">
      <div className="px-5 py-5">
        <Link href="/" aria-label="SnackLoad home">
          <SnackLoadWordmark />
        </Link>
      </div>

      <nav aria-label="Primary" className="flex-1 space-y-6 overflow-y-auto px-3 pb-6">
        {groups.map((group) => (
          <div key={group.heading}>
            <p className="px-3 pb-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-subtle">
              {group.heading}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActivePath(pathname, item.href)
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                        active
                          ? 'bg-navy-800 font-semibold text-white'
                          : 'font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink',
                      )}
                    >
                      <NavIcon name={item.icon} className="size-4.5" strokeWidth={2} />
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  )
}
