import { redirect } from 'next/navigation'
import { getAuthContext } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { greetingFor } from '@/lib/dates'
import { DESKTOP_NAV, PRIMARY_NAV, visibleItems } from '@/lib/navigation'
import { BottomNav } from '@/components/shell/BottomNav'
import { Sidebar } from '@/components/shell/Sidebar'
import { TopBar } from '@/components/shell/TopBar'
import { ConnectionBanner } from '@/components/offline/ConnectionBanner'
import { OfflineRuntime } from '@/components/offline/OfflineRuntime'
import { QueueTray } from '@/components/offline/QueueTray'
import { ownerKey } from '@/lib/offline/identity'

export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')

  const unreadCount = await db(ctx).notification.count({
    where: { readAt: null, OR: [{ userId: ctx.userId }, { userId: null }] },
  })

  const primary = visibleItems(PRIMARY_NAV, ctx.permissions)
  const desktopGroups = DESKTOP_NAV.map((group) => ({
    heading: group.heading,
    items: visibleItems(group.items, ctx.permissions),
  })).filter((group) => group.items.length > 0)

  const initials =
    `${ctx.user.firstName.charAt(0)}${ctx.user.lastName.charAt(0)}`.toUpperCase() || 'SL'

  return (
    <OfflineRuntime owner={ownerKey(ctx.organizationId, ctx.userId)}>
      <div className="flex min-h-dvh bg-surface-sunken">
        <Sidebar groups={desktopGroups} />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            greeting={greetingFor(new Date(), ctx.organization.timezone)}
            name={ctx.user.firstName}
            subtitle={ctx.organization.name}
            roleName={ctx.roleName}
            initials={initials}
            unreadCount={unreadCount}
          />

          <ConnectionBanner />
          <main className="flex-1 pb-nav md:pb-8">{children}</main>

          <QueueTray />
          <BottomNav items={primary} />
        </div>
      </div>
    </OfflineRuntime>
  )
}
