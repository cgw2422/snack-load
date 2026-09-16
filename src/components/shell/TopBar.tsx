import Link from 'next/link'
import { Bell } from 'lucide-react'
import { SnackLoadMark } from '@/components/Brand'
import { UserMenu } from './UserMenu'

export function TopBar({
  greeting,
  name,
  subtitle,
  roleName,
  initials,
  unreadCount,
}: {
  greeting: string
  name: string
  subtitle: string
  roleName: string
  initials: string
  unreadCount: number
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-navy-900 text-white safe-top md:bg-surface-raised md:text-ink">
      <div className="flex items-center gap-3 px-4 py-3 md:px-6">
        <Link href="/" className="md:hidden" aria-label="SnackLoad home">
          <SnackLoadMark className="size-9" />
        </Link>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-navy-200 md:text-ink-muted">
            {greeting}
          </p>
          <p className="truncate text-lg font-bold leading-tight md:text-base">{name}</p>
        </div>

        <p className="hidden text-sm text-ink-muted md:block">{subtitle}</p>

        <Link
          href="/notifications"
          aria-label={
            unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'
          }
          className="relative flex size-touch items-center justify-center rounded-full transition-colors hover:bg-white/10 md:hover:bg-surface-sunken"
        >
          <Bell className="size-5" aria-hidden="true" />
          {unreadCount > 0 ? (
            <span className="absolute right-1.5 top-1.5 flex min-w-4 items-center justify-center rounded-full bg-flame-500 px-1 text-[10px] font-bold text-white">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          ) : null}
        </Link>

        <UserMenu initials={initials} name={name} roleName={roleName} />
      </div>
    </header>
  )
}
