import type { Stored } from './snapshots'

/**
 * How old a cached figure is, in words (docs/05 §2).
 *
 * Measured from `storedAt` — the device's own clock at the moment it took the
 * copy — not from the server's `asOf`. The two normally agree, but a phone with
 * a wrong clock would report a figure taken thirty seconds ago as four hours
 * old, or as arriving from the future. An elapsed duration read off one clock
 * is right either way, and a duration is what the runner actually needs.
 */
export function ageLabel(snapshot: Pick<Stored<unknown>, 'storedAt'>, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - snapshot.storedAt) / 1000))
  if (seconds < 45) return 'as of a moment ago'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `as of ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `as of ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  return `as of ${days} ${days === 1 ? 'day' : 'days'} ago`
}

/**
 * Whether a figure is old enough that showing it plainly would mislead.
 *
 * Truck balances move with every sale, so the threshold is deliberately short.
 * Past it the UI is expected to mark the number, not just date it.
 */
export function isStale(
  snapshot: Pick<Stored<unknown>, 'storedAt'>,
  maxAgeMs = 15 * 60_000,
  now = Date.now(),
): boolean {
  return now - snapshot.storedAt > maxAgeMs
}
