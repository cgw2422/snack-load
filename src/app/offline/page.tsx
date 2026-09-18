import type { Metadata } from 'next'
import { OfflineScreen } from '@/components/offline/OfflineScreen'

/**
 * What the service worker serves when a navigation cannot reach the origin
 * (docs/05 §2).
 *
 * Static on purpose, and outside both the app and auth layouts. It is the one
 * HTML document kept in a cache, so it must contain nothing belonging to any
 * organization — everything on it is read from this device's own IndexedDB by
 * the client, which is where the last route snapshot and the unsent queue live.
 */
export const dynamic = 'force-static'

export const metadata: Metadata = {
  title: 'Offline',
  robots: { index: false, follow: false },
}

export default function OfflinePage() {
  return <OfflineScreen />
}
