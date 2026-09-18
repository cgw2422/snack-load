'use client'

import { useOffline } from 'next/offline'
import { CloudOff } from 'lucide-react'

/**
 * A standing, honest statement of connectivity (docs/05 §3).
 *
 * Not a toast. A toast implies something just happened and will pass; losing
 * signal in the back of a store is a condition that lasts, and the runner needs
 * to be able to glance at it while deciding whether to take a cheque.
 *
 * The state comes from the framework's own detector rather than
 * `navigator.onLine`, which reports a captive portal or a dead upstream as
 * "online" — exactly the case a runner hits on a store's guest WiFi.
 */
export function ConnectionBanner() {
  const offline = useOffline()
  if (!offline) return null

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-alert-500/15 px-4 py-2 text-center text-[13px] font-semibold text-alert-600 dark:text-alert-400"
    >
      <CloudOff className="size-4 shrink-0" aria-hidden />
      <span>No signal. Your work is saved here and sends itself when you’re back.</span>
    </div>
  )
}
