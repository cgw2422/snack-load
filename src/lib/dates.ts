/**
 * Time-zone helpers.
 *
 * A distributor's "today" is their local day, not UTC. A route in Ohio that
 * starts at 6am must not be filed under yesterday because the server runs in UTC,
 * so every "today" boundary in this app goes through here.
 *
 * Intl is used rather than a date library: it is built in, correct about DST,
 * and this is the only place that needs it.
 */

type Ymd = { year: number; month: number; day: number }

function partsIn(date: Date, timeZone: string): Ymd & { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value
      return acc
    }, {})

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl renders midnight as "24" in some locales' hour12:false output.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

/** Offset of `timeZone` from UTC at this instant, in milliseconds. */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000
}

/** The local calendar date, as YYYY-MM-DD. */
export function localDateString(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** The instant at which the local day containing `date` began. */
export function startOfDayInZone(date: Date, timeZone: string): Date {
  const p = partsIn(date, timeZone)
  const naive = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0)
  // Two passes so a day that begins across a DST transition still lands right.
  let instant = new Date(naive - offsetMs(date, timeZone))
  instant = new Date(naive - offsetMs(instant, timeZone))
  return instant
}

export function endOfDayInZone(date: Date, timeZone: string): Date {
  const start = startOfDayInZone(date, timeZone)
  const next = new Date(start.getTime() + 26 * 60 * 60 * 1000)
  return startOfDayInZone(next, timeZone)
}

/**
 * The instant a named calendar day begins in a zone.
 *
 * Distinct from `startOfDayInZone`, and the distinction matters. That one takes
 * an *instant* and asks which local day contains it. This takes a *date* —
 * "2026-09-17" — and asks when that day started.
 *
 * Passing `dateOnly('2026-09-17')` to the other one is a day-boundary bug
 * waiting to happen: `dateOnly` builds UTC midnight, which in New York is still
 * the 16th, so the answer comes back a day early. Every report filtered by an
 * explicit date range was reading the wrong window in any zone west of UTC.
 */
export function startOfLocalDate(value: string | Date, timeZone: string): Date {
  const text = typeof value === 'string' ? value : value.toISOString().slice(0, 10)
  const [year, month, day] = text.slice(0, 10).split('-').map(Number)
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0)
  // Two passes, so a day that begins across a DST transition still lands right.
  let instant = new Date(naive - offsetMs(new Date(naive), timeZone))
  instant = new Date(naive - offsetMs(instant, timeZone))
  return instant
}

/**
 * The last instant of a named calendar day, inclusive.
 *
 * An inclusive bound because the queries that use it compare with `<=`. The
 * exclusive form — the start of the next day — silently pulls in the first
 * millisecond of tomorrow, which is one sale on a busy night.
 */
export function endOfLocalDate(value: string | Date, timeZone: string): Date {
  const start = startOfLocalDate(value, timeZone)
  const nextDay = new Date(start.getTime() + 26 * 60 * 60 * 1000)
  return new Date(startOfDayInZone(nextDay, timeZone).getTime() - 1)
}

export function dayRangeInZone(date: Date, timeZone: string): { gte: Date; lt: Date } {
  return { gte: startOfDayInZone(date, timeZone), lt: endOfDayInZone(date, timeZone) }
}

/**
 * A `@db.Date` column holds a calendar date with no zone. Postgres reads it back
 * at UTC midnight, so we construct and compare it the same way.
 */
export function dateOnly(value: string | Date): Date {
  const s = typeof value === 'string' ? value : value.toISOString().slice(0, 10)
  return new Date(`${s}T00:00:00.000Z`)
}

export function todayDateOnly(timeZone: string, now = new Date()): Date {
  return dateOnly(localDateString(now, timeZone))
}

export function greetingFor(date: Date, timeZone: string): string {
  const { hour } = partsIn(date, timeZone)
  if (hour < 12) return 'Good morning,'
  if (hour < 17) return 'Good afternoon,'
  return 'Good evening,'
}

export function formatShortDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function relativeTime(date: Date, now = new Date()): string {
  const diffMs = now.getTime() - date.getTime()
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)
}

export const DAY_OF_WEEK = [
  'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY',
] as const

export function dayOfWeekInZone(date: Date, timeZone: string) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date)
  return name.toUpperCase() as (typeof DAY_OF_WEEK)[number]
}
