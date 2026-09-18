'use client'

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { hydrate } from '@/lib/offline/hydrate'
import { replay, pruneDone } from '@/lib/offline/replay'
import { IDENTITY, remember } from '@/lib/offline/snapshots'

/**
 * The client-side half of offline support (docs/05 §2, §3).
 *
 * Mounted once per layout, it does three things and deliberately renders
 * nothing:
 *
 *  1. Registers the service worker, versioned by build id, and tells it who is
 *     signed in so it knows which cache the tenant reads belong in.
 *  2. Records that identity locally, so the static offline page — which has no
 *     session — knows whose queued work to show.
 *  3. Drains the mutation queue — and refreshes this device's copy of the
 *     runner's day — whenever there is reason to think either might go through:
 *     on mount, when the browser says the connection is back, and when the
 *     runner brings the app to the foreground.
 *
 * `owner` is `null` on the signed-out screens. That is not a no-op: it is the
 * signal that empties every cached tenant read on this device.
 *
 * It also publishes that identity to the client tree, because every component
 * that queues a mutation has to stamp it with the same owner the drain filters
 * on.
 */
const OwnerContext = createContext<string | null>(null)

/**
 * Who is signed in, for a client component that needs to queue something.
 *
 * `null` means nobody — which is not a reason to queue anyway. An entry with no
 * owner could never be drained safely, so callers treat it as "cannot queue".
 */
export function useOwner(): string | null {
  return useContext(OwnerContext)
}

export function OfflineRuntime({
  owner,
  children,
}: {
  owner: string | null
  children?: ReactNode
}) {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    if (process.env.NODE_ENV !== 'production') {
      // A worker holding Turbopack output across an edit is a debugging session
      // nobody asked for. Any worker left from a production build is removed.
      void navigator.serviceWorker
        .getRegistrations()
        .then((all) => Promise.all(all.map((one) => one.unregister())))
        .catch(() => undefined)
      return
    }

    void navigator.serviceWorker
      .register(`/sw.js?v=${process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev'}`, {
        scope: '/',
        // The worker script itself must never come from the HTTP cache; it is
        // what decides how stale everything else may be.
        updateViaCache: 'none',
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const tell = (worker: ServiceWorker | null) => {
      worker?.postMessage(owner ? { type: 'IDENTITY', owner } : { type: 'SIGN_OUT' })
    }

    tell(navigator.serviceWorker.controller)
    // A first load has no controller yet; `ready` resolves once one is in charge.
    void navigator.serviceWorker.ready.then((registration) => tell(registration.active))

    if (owner) void remember(IDENTITY, { asOf: new Date().toISOString(), owner })
  }, [owner])

  useEffect(() => {
    if (!owner) return

    let cancelled = false
    const drain = () => {
      if (cancelled || !navigator.onLine) return
      void replay(owner)
        .then(() => pruneDone())
        // Sending first, then reading: a refreshed balance that does not yet
        // account for the sale still sitting in the queue is a number the
        // runner would have to reconcile in their head.
        .then(() => hydrate())
        .catch(() => undefined)
    }

    drain()
    const onVisible = () => {
      if (document.visibilityState === 'visible') drain()
    }

    window.addEventListener('online', drain)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.removeEventListener('online', drain)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [owner])

  return <OwnerContext.Provider value={owner}>{children}</OwnerContext.Provider>
}
