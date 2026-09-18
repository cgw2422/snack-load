'use client'

import { useEffect, useState } from 'react'
import { Check, ChevronUp, CloudUpload, TriangleAlert, X } from 'lucide-react'
import { discard, retry, subscribe, type QueueSnapshot } from '@/lib/offline/queue'
import { replay } from '@/lib/offline/replay'
import { useOwner } from './OfflineRuntime'

/**
 * What the runner is still owed by the network (docs/05 §3).
 *
 * The tray exists because of one rule: **nothing pretends to have succeeded
 * before it has.** A sale taken in a dead zone is real money in a real till,
 * and the runner has to be able to see, at the end of the day, that every one
 * of them reached the office.
 *
 * It shows itself only when there is something to say. A tray that is always
 * on screen is a tray nobody reads.
 */
export function QueueTray() {
  const owner = useOwner()
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!owner) return
    return subscribe(owner, setQueue)
  }, [owner])

  if (!owner || !queue) return null

  const waiting = queue.pending + queue.sending
  const landed = queue.entries.filter((entry) => entry.status === 'done').length
  if (waiting === 0 && queue.blocked === 0 && queue.stranded === 0) return null

  return (
    // In flow, directly under the connection banner, rather than pinned to the
    // bottom of the screen. The bottom is already spoken for on the screen that
    // matters most: the sell screen's running total sits there, and a tray
    // covering the checkout button would be worse than one that scrolls.
    <div className="px-3 pt-3 md:px-6">
      <div className="mx-auto max-w-2xl overflow-hidden rounded-card border border-line bg-surface-raised shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left"
        >
          {queue.blocked > 0 ? (
            <TriangleAlert className="size-5 shrink-0 text-stop-500" aria-hidden />
          ) : (
            <CloudUpload className="size-5 shrink-0 text-ink-muted" aria-hidden />
          )}

          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">
              {queue.blocked > 0
                ? `${queue.blocked} ${queue.blocked === 1 ? 'item needs' : 'items need'} your attention`
                : `${waiting} ${waiting === 1 ? 'item' : 'items'} waiting to send`}
            </span>
            <span className="block text-xs text-ink-muted">
              {queue.blocked > 0
                ? 'The office refused these. Nothing was posted.'
                : 'Saved on this phone. Sends itself when there’s a signal.'}
              {queue.stranded > 0
                ? ` · ${queue.stranded} from another sign-in`
                : ''}
            </span>
          </span>

          <ChevronUp
            className={`size-4 shrink-0 text-ink-subtle transition-transform ${open ? '' : 'rotate-180'}`}
            aria-hidden
          />
        </button>

        {open ? (
          <ul className="max-h-64 divide-y divide-line overflow-y-auto border-t border-line">
            {queue.entries.map((entry) => (
              <li key={entry.id} className="flex items-start gap-2.5 px-3.5 py-2.5 text-sm">
                {entry.status === 'blocked' ? (
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-stop-500" aria-hidden />
                ) : entry.status === 'done' ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-cash-500" aria-hidden />
                ) : (
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-ink-subtle" aria-hidden />
                )}

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{entry.label}</span>
                  {entry.error ? (
                    <span className="block text-xs text-stop-600">{entry.error}</span>
                  ) : entry.result?.repriced ? (
                    <span className="block text-xs text-alert-600">
                      Priced at {entry.result.total} on arrival — not the {entry.clientEstimate}{' '}
                      shown at the counter.
                    </span>
                  ) : null}
                </span>

                {entry.status === 'blocked' ? (
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => void retry(entry.id).then(() => replay(owner))}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-navy-800 hover:bg-surface-sunken dark:text-flame-300"
                    >
                      Try again
                    </button>
                    <button
                      type="button"
                      aria-label={`Discard ${entry.label}`}
                      onClick={() => void discard(entry.id)}
                      className="flex size-7 items-center justify-center rounded-lg text-ink-subtle hover:bg-stop-500/5 hover:text-stop-600"
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </span>
                ) : null}
              </li>
            ))}

            {queue.stranded > 0 ? (
              <li className="px-3.5 py-2.5 text-xs text-ink-muted">
                {queue.stranded} {queue.stranded === 1 ? 'item was' : 'items were'} queued by
                someone else signed in on this phone. They are kept, and go when that person
                signs back in.
              </li>
            ) : null}
          </ul>
        ) : null}

        {landed > 0 && !open ? (
          <p className="border-t border-line px-3.5 py-2 text-xs text-cash-600">
            {landed} {landed === 1 ? 'item' : 'items'} landed just now.
          </p>
        ) : null}
      </div>
    </div>
  )
}
