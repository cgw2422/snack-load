import { all, available, get, put, QUEUE, remove } from './db'

/**
 * The durable mutation queue (docs/05 §3).
 *
 * What it is for: a runner in the back of a store with no signal completes a
 * sale, takes the cash, and closes the stop. All three must reach the server
 * eventually, in that order, exactly once — and none of them may pretend to
 * have succeeded before they have.
 *
 * What it deliberately does **not** do:
 *
 *  - It does not assign receipt numbers, decrement stock, or compute money.
 *    The entry carries *intent*. Everything else is the server's (docs/05 §3).
 *  - It does not merge. There is no client-side reconciliation of two versions
 *    of a sale, because there is only ever one version.
 *  - It does not silently drop anything. An entry that cannot be sent stays
 *    visible, with the server's own words on it.
 *
 * Exactly-once comes from the **idempotency key travelling with the entry**,
 * never regenerated. A lost response is indistinguishable from a failure on the
 * client, so the queue simply sends again; the server recognises the key and
 * replays its original answer rather than posting twice.
 */

export type QueueKind = 'sale' | 'payment' | 'stop'

export type QueueStatus =
  /** Waiting for a connection, or for the entries in front of it. */
  | 'pending'
  /** In flight right now. */
  | 'sending'
  /** Accepted by the server. Kept briefly so the runner sees it landed. */
  | 'done'
  /** The server refused it, and a person has to decide. */
  | 'blocked'

export type QueueEntry = {
  id: string
  /**
   * Who queued this, as `organizationId:userId`.
   *
   * A phone is shared. If a runner signs out with unsent sales and a relief
   * driver signs in, those sales must not be replayed — the server would post
   * them as the person now holding the session, against the wrong route and
   * possibly the wrong organization. So they are not deleted either: they stay
   * put, stranded but intact, until their owner signs back in.
   */
  owner: string
  kind: QueueKind
  /** Where to send it. Built when the entry is created, not when it is sent. */
  endpoint: string
  /** Intent only. Validated server-side by the same schema a live submit uses. */
  payload: unknown
  /** Monotonic within this device: replay follows the runner's own order. */
  sequence: number
  status: QueueStatus
  attempts: number
  /** Device clock, recorded for support and never trusted as a document date. */
  occurredAtClient: string
  /** What the runner was shown. Not a price (docs/05 §3). */
  clientEstimate?: string
  /** A one-line description, so the tray reads like the runner's day. */
  label: string
  /** The server's own words, when it refused. */
  error?: string
  /** Set once accepted, so the tray can link to the real document. */
  result?: { id?: string; number?: string; total?: string; repriced?: boolean }
  nextAttemptAt: number
}

export type QueueSnapshot = {
  pending: number
  blocked: number
  sending: number
  /** Entries belonging to a different sign-in on this device. Shown, not sent. */
  stranded: number
  entries: QueueEntry[]
}

const listeners = new Set<(snapshot: QueueSnapshot) => void>()

/**
 * The next position in the runner's day.
 *
 * Derived from the queue itself rather than kept in `localStorage`, which a
 * browser can clear independently of IndexedDB — and a sequence that restarts
 * at 1 while entries numbered 40 are still waiting would replay a payment
 * before the sale it settles.
 *
 * `issued` covers the gap between two enqueues in the same tick, before the
 * first write has landed.
 */
let issued = 0

async function nextSequence(): Promise<number> {
  const rows = await all<QueueEntry>(QUEUE).catch(() => [] as QueueEntry[])
  const highest = rows.reduce((max, row) => Math.max(max, row.sequence), 0)
  issued = Math.max(issued, highest) + 1
  return issued
}

export async function enqueue(input: {
  id: string
  owner: string
  kind: QueueKind
  endpoint: string
  payload: unknown
  label: string
  clientEstimate?: string
}): Promise<QueueEntry> {
  const entry: QueueEntry = {
    ...input,
    sequence: await nextSequence(),
    status: 'pending',
    attempts: 0,
    occurredAtClient: new Date().toISOString(),
    nextAttemptAt: Date.now(),
  }

  await put(QUEUE, entry)
  await notify()
  return entry
}

/** Only for tests, which start each case from an empty store. */
export function resetSequenceForTesting(): void {
  issued = 0
}

/** Everything on the device, whoever queued it. */
export async function entries(): Promise<QueueEntry[]> {
  if (!available()) return []
  const rows = await all<QueueEntry>(QUEUE)
  return rows.sort((a, b) => a.sequence - b.sequence)
}

/** Only what the person currently signed in may send. */
export async function entriesFor(owner: string): Promise<QueueEntry[]> {
  return (await entries()).filter((row) => row.owner === owner)
}

export async function snapshot(owner: string): Promise<QueueSnapshot> {
  const rows = await entries()
  const mine = rows.filter((row) => row.owner === owner)
  return {
    pending: mine.filter((row) => row.status === 'pending').length,
    sending: mine.filter((row) => row.status === 'sending').length,
    blocked: mine.filter((row) => row.status === 'blocked').length,
    stranded: rows.length - mine.length,
    entries: mine,
  }
}

let watching: string | null = null

export function subscribe(
  owner: string,
  listener: (snapshot: QueueSnapshot) => void,
): () => void {
  watching = owner
  listeners.add(listener)
  void notify()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) watching = null
  }
}

async function notify(): Promise<void> {
  if (listeners.size === 0 || watching === null) return
  const current = await snapshot(watching)
  for (const listener of listeners) listener(current)
}

/** A blocked entry a person has looked at and wants to try again. */
export async function retry(id: string): Promise<void> {
  const entry = await get<QueueEntry>(QUEUE, id)
  if (!entry) return
  await put(QUEUE, { ...entry, status: 'pending', error: undefined, nextAttemptAt: Date.now() })
  await notify()
}

/**
 * Removing an entry the runner has decided against.
 *
 * Only ever a *blocked* one: discarding something still pending could drop a
 * sale the server has in fact already accepted but not yet acknowledged.
 */
export async function discard(id: string): Promise<void> {
  const entry = await get<QueueEntry>(QUEUE, id)
  if (!entry || entry.status !== 'blocked') return
  await remove(QUEUE, id)
  await notify()
}

export async function forget(id: string): Promise<void> {
  await remove(QUEUE, id)
  await notify()
}

export async function update(id: string, patch: Partial<QueueEntry>): Promise<void> {
  const entry = await get<QueueEntry>(QUEUE, id)
  if (!entry) return
  await put(QUEUE, { ...entry, ...patch })
  await notify()
}
