'use client'

import { useCallback, useEffect, useState } from 'react'
import { CloudOff, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ageLabel } from '@/lib/offline/age'
import { entries, type QueueEntry } from '@/lib/offline/queue'
import { IDENTITY, recall, ROUTE_DAY, type Stored } from '@/lib/offline/snapshots'

type RouteDaySnapshot = {
  route: { name: string; stops: { id: string; sequence: number; status: string; customerName: string; addressLine: string }[] } | null
}

/**
 * The offline screen (docs/05 §2, §3).
 *
 * It is shown when a page could not be fetched, which means it has no session
 * and no server data. Everything on it comes from this device: the last route
 * snapshot the app stored, and the mutations still waiting to be sent.
 *
 * Two things it will not do. It will not present a cached figure as current —
 * every number here carries its age. And it will not offer to "send now": the
 * queue drains itself when a connection returns, and a button implying the
 * runner controls that would be a lie about who is holding their sales.
 */
export function OfflineScreen() {
  const [queued, setQueued] = useState<QueueEntry[] | null>(null)
  const [day, setDay] = useState<Stored<RouteDaySnapshot> | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const owner = (await recall<{ owner: string }>(IDENTITY))?.value.owner ?? null
      const rows = await entries().catch(() => [] as QueueEntry[])
      const snapshot = await recall<RouteDaySnapshot>(ROUTE_DAY)
      if (cancelled) return

      setQueued(rows.filter((row) => row.owner === owner && row.status !== 'done'))
      setDay(snapshot ?? null)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const retry = useCallback(() => {
    window.location.reload()
  }, [])

  const waiting = queued?.filter((row) => row.status !== 'blocked').length ?? 0
  const blocked = queued?.filter((row) => row.status === 'blocked').length ?? 0
  const stops = day?.value.route?.stops ?? []

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <CloudOff className="size-10 text-ink-subtle" aria-hidden />
        <h1 className="text-xl font-semibold text-ink">No connection</h1>
        <p className="text-sm text-ink-muted">
          SnackLoad can’t reach the server. Your work is saved on this phone and goes
          up on its own as soon as there’s a signal.
        </p>
        <Button onClick={retry} variant="primary" size="lg" block className="mt-2">
          <RefreshCw className="size-5" aria-hidden />
          Try again
        </Button>
      </div>

      <Card className="mt-6 p-4">
        <h2 className="text-[15px] font-semibold text-ink">Waiting to send</h2>
        {queued === null ? (
          <p className="mt-2 text-sm text-ink-muted">Checking…</p>
        ) : queued.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">Nothing is waiting. Everything you did has landed.</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-muted">
              {waiting} {waiting === 1 ? 'item' : 'items'} queued
              {blocked > 0 ? `, ${blocked} needing attention` : ''}.
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              {queued.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2 text-sm">
                  {entry.status === 'blocked' ? (
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-stop-500" aria-hidden />
                  ) : (
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-ink-subtle" aria-hidden />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-ink">{entry.label}</span>
                    {entry.error ? (
                      <span className="block text-xs text-stop-600">{entry.error}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {stops.length > 0 && day ? (
        <Card className="mt-4 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-ink">
              {day.value.route?.name ?? 'Today’s route'}
            </h2>
            {/* Never a bare figure: a cached list shown as live is the thing
                docs/05 §2 refuses. */}
            <span className="text-xs text-ink-subtle">{ageLabel(day)}</span>
          </div>
          <ol className="mt-3 flex flex-col gap-2">
            {stops.map((stop) => (
              <li key={stop.id} className="flex gap-3 text-sm">
                <span className="w-5 shrink-0 text-ink-subtle">{stop.sequence}</span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{stop.customerName}</span>
                  <span className="block truncate text-xs text-ink-muted">{stop.addressLine}</span>
                </span>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
    </div>
  )
}
