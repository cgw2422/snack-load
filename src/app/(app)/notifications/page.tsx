import type { Metadata } from 'next'
import { Card, EmptyState } from '@/components/ui/Card'
import { requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { relativeTime } from '@/lib/dates'

export const metadata: Metadata = { title: 'Notifications' }

const TONE: Record<string, string> = {
  INFO: 'bg-navy-100 text-navy-700',
  WARNING: 'bg-amber-100 text-alert-600',
  CRITICAL: 'bg-stop-500/10 text-stop-600',
}

export default async function NotificationsPage() {
  const ctx = await requireAuth()

  const notifications = await db(ctx).notification.findMany({
    where: { OR: [{ userId: ctx.userId }, { userId: null }] },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-4 md:px-6 md:py-6">
      <h1 className="mb-4 text-xl font-extrabold text-ink">Notifications</h1>

      <Card>
        {notifications.length === 0 ? (
          <EmptyState
            title="Nothing to catch up on"
            description="Low stock, overdue accounts, route status and sync problems will appear here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {notifications.map((notification) => (
              <li key={notification.id} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    TONE[notification.severity] ?? TONE.INFO
                  }`}
                >
                  {notification.severity}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">
                    {notification.title}
                  </span>
                  {notification.body ? (
                    <span className="block text-sm text-ink-muted">{notification.body}</span>
                  ) : null}
                  <span className="block text-xs text-ink-subtle">
                    {relativeTime(notification.createdAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
