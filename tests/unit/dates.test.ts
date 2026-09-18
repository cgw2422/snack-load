import { describe, expect, it } from 'vitest'
import {
  dateOnly,
  dayOfWeekInZone,
  dayRangeInZone,
  endOfLocalDate,
  greetingFor,
  startOfLocalDate,
  localDateString,
  startOfDayInZone,
  todayDateOnly,
} from '@/lib/dates'

/**
 * A distributor's "today" is their local day. A route that starts at 6am in Ohio
 * must not be filed under yesterday because the server runs in UTC.
 */
describe('local day boundaries', () => {
  const OHIO = 'America/New_York'

  it('reads the local calendar date, not the UTC one', () => {
    // 01:30 UTC on the 17th is still the evening of the 16th in Ohio.
    const instant = new Date('2026-09-17T01:30:00.000Z')
    expect(localDateString(instant, OHIO)).toBe('2026-09-16')
    expect(localDateString(instant, 'UTC')).toBe('2026-09-17')
  })

  it('finds the instant the local day began', () => {
    // Midnight on 2026-09-16 in EDT (UTC−4) is 04:00Z.
    const start = startOfDayInZone(new Date('2026-09-16T18:00:00.000Z'), OHIO)
    expect(start.toISOString()).toBe('2026-09-16T04:00:00.000Z')
  })

  it('handles a zone on the other side of UTC', () => {
    // Midnight in Tokyo (UTC+9) is 15:00Z the previous day.
    const start = startOfDayInZone(new Date('2026-09-16T18:00:00.000Z'), 'Asia/Tokyo')
    expect(start.toISOString()).toBe('2026-09-16T15:00:00.000Z')
  })

  it('stays correct either side of a daylight-saving change', () => {
    // EDT (UTC−4) before the November change, EST (UTC−5) after it.
    expect(startOfDayInZone(new Date('2026-10-15T18:00:00Z'), OHIO).toISOString()).toBe(
      '2026-10-15T04:00:00.000Z',
    )
    expect(startOfDayInZone(new Date('2026-11-15T18:00:00Z'), OHIO).toISOString()).toBe(
      '2026-11-15T05:00:00.000Z',
    )
  })

  it('produces a day range that is exactly 24 hours in a normal week', () => {
    const { gte, lt } = dayRangeInZone(new Date('2026-09-16T18:00:00Z'), OHIO)
    expect(lt.getTime() - gte.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('produces a 23-hour day when the clocks go forward', () => {
    // 2026-03-08 is the US spring-forward date.
    const { gte, lt } = dayRangeInZone(new Date('2026-03-08T18:00:00Z'), OHIO)
    expect(lt.getTime() - gte.getTime()).toBe(23 * 60 * 60 * 1000)
  })

  it('treats a @db.Date value as UTC midnight, the way Postgres reads it back', () => {
    expect(dateOnly('2026-09-16').toISOString()).toBe('2026-09-16T00:00:00.000Z')
    expect(todayDateOnly(OHIO, new Date('2026-09-17T01:30:00Z')).toISOString()).toBe(
      '2026-09-16T00:00:00.000Z',
    )
  })

  it('names the local weekday, which is what route schedules key on', () => {
    expect(dayOfWeekInZone(new Date('2026-09-17T01:30:00Z'), OHIO)).toBe('WEDNESDAY')
    expect(dayOfWeekInZone(new Date('2026-09-17T01:30:00Z'), 'UTC')).toBe('THURSDAY')
  })

  it('greets by local hour', () => {
    expect(greetingFor(new Date('2026-09-16T13:00:00Z'), OHIO)).toBe('Good morning,')
    expect(greetingFor(new Date('2026-09-16T18:00:00Z'), OHIO)).toBe('Good afternoon,')
    expect(greetingFor(new Date('2026-09-16T23:00:00Z'), OHIO)).toBe('Good evening,')
  })
})

/**
 * Calendar days versus instants (found while building the COGS batch).
 *
 * `startOfDayInZone` takes an instant and asks which local day contains it.
 * `startOfLocalDate` takes a named day and asks when it began. Feeding
 * `dateOnly('2026-09-17')` — UTC midnight — to the first one answers for the
 * 16th in any zone west of UTC, which is what every report filtered by an
 * explicit date range was doing.
 */
describe('named calendar days', () => {
  it('starts a named day at local midnight, not at UTC midnight', () => {
    const start = startOfLocalDate('2026-09-17', 'America/New_York')
    expect(start.toISOString()).toBe('2026-09-17T04:00:00.000Z')

    // The old mistake, kept here so the difference is visible rather than
    // remembered: an instant of UTC midnight is still the previous evening.
    expect(startOfDayInZone(dateOnly('2026-09-17'), 'America/New_York').toISOString()).toBe(
      '2026-09-16T04:00:00.000Z',
    )
  })

  it('ends a named day at its last millisecond, inclusively', () => {
    const end = endOfLocalDate('2026-09-17', 'America/New_York')
    expect(end.toISOString()).toBe('2026-09-18T03:59:59.999Z')
    // Not the first instant of tomorrow: the queries compare with <=, and one
    // millisecond of the next day is one sale on a busy night.
    expect(end.getTime()).toBe(startOfLocalDate('2026-09-18', 'America/New_York').getTime() - 1)
  })

  it('handles a day that is not 24 hours long', () => {
    // US daylight saving ends on 1 November 2026: a 25-hour day.
    const start = startOfLocalDate('2026-11-01', 'America/New_York')
    const end = endOfLocalDate('2026-11-01', 'America/New_York')
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000 - 1)

    // And the spring transition, a 23-hour day.
    const springStart = startOfLocalDate('2026-03-08', 'America/New_York')
    const springEnd = endOfLocalDate('2026-03-08', 'America/New_York')
    expect(springEnd.getTime() - springStart.getTime()).toBe(23 * 60 * 60 * 1000 - 1)
  })

  it('agrees with itself east of UTC too', () => {
    expect(startOfLocalDate('2026-09-17', 'Europe/Berlin').toISOString()).toBe(
      '2026-09-16T22:00:00.000Z',
    )
    expect(startOfLocalDate('2026-09-17', 'UTC').toISOString()).toBe('2026-09-17T00:00:00.000Z')
  })
})
