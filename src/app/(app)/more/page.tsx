import Link from 'next/link'
import type { Metadata } from 'next'
import { ChevronRight, LogOut } from 'lucide-react'
import { requireAuth } from '@/server/auth/context'
import { MORE_NAV, visibleItems } from '@/lib/navigation'
import { Card } from '@/components/ui/Card'
import { NavIcon } from '@/components/shell/NavIcon'
import { logoutAction } from '@/app/(auth)/actions'
import { InstallHint } from '@/components/offline/InstallHint'

export const metadata: Metadata = { title: 'More' }

export default async function MorePage() {
  const ctx = await requireAuth()
  const items = visibleItems(MORE_NAV, ctx.permissions)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4">
      <Card>
        <div className="border-b border-line px-4 py-4">
          <p className="text-sm font-semibold text-ink">{ctx.organization.name}</p>
          <p className="text-xs text-ink-muted">
            {ctx.user.firstName} {ctx.user.lastName} · {ctx.roleName}
          </p>
        </div>

        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex min-h-touch items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-navy-700 dark:text-navy-100">
                  <NavIcon name={item.icon} className="size-5" strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{item.label}</span>
                  {item.description ? (
                    <span className="block truncate text-xs text-ink-muted">
                      {item.description}
                    </span>
                  ) : null}
                </span>
                <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <InstallHint />

      <form action={logoutAction}>
        <button
          type="submit"
          className="flex min-h-touch w-full items-center justify-center gap-2 rounded-card border border-line bg-surface-raised text-sm font-semibold text-stop-600 transition-colors hover:bg-stop-500/5"
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </button>
      </form>

      <p className="pt-2 text-center text-xs text-ink-subtle">
        SnackLoad · Load it. Route it. Sell it.
      </p>
    </div>
  )
}
