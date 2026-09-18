'use client'

import { useSyncExternalStore } from 'react'
import { Share, SquarePlus, Smartphone } from 'lucide-react'
import { Card } from '@/components/ui/Card'

/**
 * How to get SnackLoad onto the home screen (docs/05 §2).
 *
 * Installed matters here beyond convenience: a home-screen app on iOS gets its
 * own storage, so the mutation queue is not sharing a bucket Safari may evict,
 * and it launches straight into portrait without the browser chrome eating the
 * bottom of a 320px screen.
 *
 * iOS has no install prompt to fire — Safari's share sheet is the only route —
 * and `beforeinstallprompt` is Chromium-only, so this explains rather than
 * offers. It hides itself once the app is already running standalone, which is
 * the only case where saying anything would be noise.
 */
type Platform = 'ios' | 'other' | 'installed'

/**
 * Read once, after hydration.
 *
 * `useSyncExternalStore` rather than an effect: the answer is a property of the
 * browser that never changes while the page is open, and the server has no way
 * to know it. The server snapshot is `null`, so the card is simply absent from
 * the HTML instead of flashing the wrong instructions before hydration.
 */
const NEVER_CHANGES = () => () => {}

function readPlatform(): Platform {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS never adopted `display-mode: standalone` for home-screen apps.
    (navigator as unknown as { standalone?: boolean }).standalone === true

  if (standalone) return 'installed'
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ? 'ios' : 'other'
}

export function InstallHint() {
  const platform = useSyncExternalStore<Platform | null>(NEVER_CHANGES, readPlatform, () => null)

  if (platform === null || platform === 'installed') return null

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-navy-700 dark:text-navy-100">
          <Smartphone className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">Put SnackLoad on your home screen</p>
          {platform === 'ios' ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-ink-muted">
              Tap
              <Share className="inline size-3.5" aria-label="the share button" />
              then
              <SquarePlus className="inline size-3.5" aria-hidden />
              <span className="font-semibold">Add to Home Screen</span>.
            </p>
          ) : (
            <p className="mt-1 text-xs text-ink-muted">
              Use your browser’s menu and choose <span className="font-semibold">Install app</span>{' '}
              or <span className="font-semibold">Add to Home screen</span>.
            </p>
          )}
          <p className="mt-1.5 text-xs text-ink-subtle">
            Installed, it opens full screen and keeps your unsent work in its own storage.
          </p>
        </div>
      </div>
    </Card>
  )
}
