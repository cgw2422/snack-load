import { entries, entriesFor, forget, update, type QueueEntry } from './queue'

/**
 * Sending what the queue is holding (docs/05 §3).
 *
 * The rules, and the reason for each:
 *
 *  1. **In order.** A payment can reference a sale, and a stop closes after the
 *     sale made at it. Replaying by sequence keeps the runner's day readable
 *     and keeps references valid.
 *  2. **One at a time.** Parallel sends would reorder on the wire, and there is
 *     nothing to gain: a runner's queue is a handful of entries, not a batch job.
 *  3. **Stop at the first thing that is still waiting.** If an entry cannot go
 *     because there is no signal, neither can the ones behind it, and hammering
 *     them all produces a burst of failures the moment a tunnel ends.
 *  4. **A lost response is a retry, never a new document.** The idempotency key
 *     travels with the entry and is never regenerated, so the server replays
 *     its original answer rather than posting a second sale. This is the whole
 *     guarantee; everything else is scheduling.
 *  5. **A refusal stops being retried.** A validation error will not fix itself,
 *     so it is shown with the server's own words rather than looped forever.
 *  6. **Only the owner's entries go.** A drain sends what the person currently
 *     signed in queued, and nothing else. Anything left by an earlier sign-in
 *     on a shared phone is left exactly where it is — replaying it would post
 *     one runner's sale under another runner's session.
 */

/** A refusal: retrying will not change the answer. */
const TERMINAL_STATUSES = new Set([400, 403, 404, 409, 422])
/** Sign-in expired. The entry keeps, and goes when somebody signs in again. */
const AUTH_STATUSES = new Set([401])

export type ReplayOutcome = {
  sent: number
  blocked: number
  /** Why the pass stopped, when it stopped early. */
  stoppedBecause: 'EMPTY' | 'OFFLINE' | 'BLOCKED' | 'AUTH' | null
}

const running = new Map<string, Promise<ReplayOutcome>>()

/**
 * Drains what `owner` has queued. Concurrent calls share one pass — a reconnect
 * event and a visibility change firing together must not send everything twice.
 */
export function replay(owner: string, fetchImpl: typeof fetch = fetch): Promise<ReplayOutcome> {
  const existing = running.get(owner)
  if (existing) return existing

  const pass = drain(owner, fetchImpl).finally(() => {
    running.delete(owner)
  })
  running.set(owner, pass)
  return pass
}

async function drain(owner: string, fetchImpl: typeof fetch): Promise<ReplayOutcome> {
  const outcome: ReplayOutcome = { sent: 0, blocked: 0, stoppedBecause: null }

  const queued = (await entriesFor(owner)).filter((entry) => entry.status !== 'done')
  if (queued.length === 0) {
    outcome.stoppedBecause = 'EMPTY'
    return outcome
  }

  for (const entry of queued) {
    if (entry.status === 'blocked') {
      outcome.blocked += 1
      continue
    }
    if (entry.nextAttemptAt > Date.now()) {
      outcome.stoppedBecause = 'OFFLINE'
      break
    }

    const result = await send(entry, fetchImpl)

    if (result.kind === 'accepted') {
      outcome.sent += 1
      // Kept for a moment so the runner sees it landed, then dropped by the
      // tray. Holding them forever would turn the queue into a receipt list.
      await update(entry.id, { status: 'done', result: result.body, error: undefined })
      continue
    }

    if (result.kind === 'refused') {
      outcome.blocked += 1
      await update(entry.id, {
        status: 'blocked',
        attempts: entry.attempts + 1,
        error: result.message,
      })
      continue
    }

    if (result.kind === 'unauthenticated') {
      await update(entry.id, { status: 'pending', attempts: entry.attempts + 1 })
      outcome.stoppedBecause = 'AUTH'
      break
    }

    // Unreachable, or the server is having a bad minute. Back off and stop:
    // everything behind this is in the same position.
    await update(entry.id, {
      status: 'pending',
      attempts: entry.attempts + 1,
      nextAttemptAt: Date.now() + backoffMs(entry.attempts + 1),
      error: undefined,
    })
    outcome.stoppedBecause = 'OFFLINE'
    break
  }

  return outcome
}

type SendResult =
  | { kind: 'accepted'; body: QueueEntry['result'] }
  | { kind: 'refused'; message: string }
  | { kind: 'unauthenticated' }
  | { kind: 'unreachable' }

async function send(entry: QueueEntry, fetchImpl: typeof fetch): Promise<SendResult> {
  await update(entry.id, { status: 'sending' })

  let response: Response
  try {
    response = await fetchImpl(entry.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Never cached, never revalidated from a stale copy: a mutation replayed
      // out of a cache is a mutation nobody can account for (docs/05 §2).
      cache: 'no-store',
      body: JSON.stringify({
        payload: entry.payload,
        occurredAtClient: entry.occurredAtClient,
        clientEstimate: entry.clientEstimate,
        attempt: entry.attempts + 1,
      }),
    })
  } catch {
    return { kind: 'unreachable' }
  }

  if (response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    return {
      kind: 'accepted',
      body: {
        id: asText(body.saleId ?? body.paymentId ?? body.id),
        number: asText(body.saleNumber ?? body.receiptNumber),
        total: asText(body.total ?? body.amount),
        repriced: body.repriced === true,
      },
    }
  }

  if (AUTH_STATUSES.has(response.status)) return { kind: 'unauthenticated' }

  if (TERMINAL_STATUSES.has(response.status)) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null
    return {
      kind: 'refused',
      message: body?.error?.message ?? `The server refused this (HTTP ${response.status}).`,
    }
  }

  return { kind: 'unreachable' }
}

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * Backoff for an unreachable server: five seconds doubling to five minutes.
 *
 * Shorter than the QuickBooks worker's on purpose. That one is talking to
 * somebody else's rate-limited API; this one is a runner standing in a car park
 * waiting for a bar of signal, and a five-minute wait after the signal returns
 * is a runner who thinks the app is broken.
 */
export function backoffMs(attempts: number): number {
  const base = Math.min(5_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS)
  // Capped AFTER the jitter. Capping first and then multiplying by up to 1.25
  // puts the delay back over the ceiling it exists to enforce.
  return Math.min(Math.round(base * (0.75 + Math.random() * 0.5)), MAX_BACKOFF_MS)
}

const MAX_BACKOFF_MS = 300_000

/** Entries the tray has shown as landed can go. */
export async function pruneDone(olderThanMs = 60_000): Promise<void> {
  const now = Date.now()
  for (const entry of await entries()) {
    if (entry.status !== 'done') continue
    if (now - Date.parse(entry.occurredAtClient) > olderThanMs) await forget(entry.id)
  }
}
