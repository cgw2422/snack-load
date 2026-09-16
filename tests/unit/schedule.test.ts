import { describe, expect, it } from 'vitest'
import {
  daysOverdue,
  describeFrequency,
  isDueOn,
  nextDayOfWeek,
  nextDueDate,
} from '@/server/domain/schedule'

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

describe('finding the next weekday', () => {
  it('returns the same day when it already matches', () => {
    // 2026-09-15 is a Tuesday.
    expect(nextDayOfWeek(d('2026-09-15'), 'TUESDAY').toISOString().slice(0, 10)).toBe('2026-09-15')
  })

  it('moves forward to the next matching day', () => {
    expect(nextDayOfWeek(d('2026-09-16'), 'TUESDAY').toISOString().slice(0, 10)).toBe('2026-09-22')
    expect(nextDayOfWeek(d('2026-09-16'), 'FRIDAY').toISOString().slice(0, 10)).toBe('2026-09-18')
  })
})

describe('when an account is next due', () => {
  it('puts a brand-new account on the very next matching day', () => {
    // A store signed up today should be on this week's run, not next fortnight.
    const due = nextDueDate({ frequency: 'BIWEEKLY', dayOfWeek: 'TUESDAY' }, d('2026-09-16'))
    expect(due.toISOString().slice(0, 10)).toBe('2026-09-22')
  })

  it('counts a weekly cycle from the last visit', () => {
    const due = nextDueDate(
      { frequency: 'WEEKLY', dayOfWeek: 'TUESDAY', lastServicedOn: d('2026-09-15') },
      d('2026-09-16'),
    )
    expect(due.toISOString().slice(0, 10)).toBe('2026-09-22')
  })

  it('counts a fortnightly cycle from the last visit', () => {
    const due = nextDueDate(
      { frequency: 'BIWEEKLY', dayOfWeek: 'TUESDAY', lastServicedOn: d('2026-09-15') },
      d('2026-09-16'),
    )
    expect(due.toISOString().slice(0, 10)).toBe('2026-09-29')
  })

  it('counts a three-week cycle', () => {
    const due = nextDueDate(
      { frequency: 'TRIWEEKLY', dayOfWeek: 'TUESDAY', lastServicedOn: d('2026-09-15') },
      d('2026-09-16'),
    )
    expect(due.toISOString().slice(0, 10)).toBe('2026-10-06')
  })

  it('keeps a monthly account on its weekday rather than its date', () => {
    // A month after Tuesday 15 Sep is 15 Oct, a Thursday; the run is Tuesdays,
    // so the account lands on Tuesday 20 Oct.
    const due = nextDueDate(
      { frequency: 'MONTHLY', dayOfWeek: 'TUESDAY', lastServicedOn: d('2026-09-15') },
      d('2026-09-16'),
    )
    expect(due.toISOString().slice(0, 10)).toBe('2026-10-20')
  })

  it('honours a custom interval', () => {
    const due = nextDueDate(
      {
        frequency: 'CUSTOM',
        dayOfWeek: 'TUESDAY',
        intervalDays: 10,
        lastServicedOn: d('2026-09-15'),
      },
      d('2026-09-16'),
    )
    // 10 days on is Friday 25 Sep; the next Tuesday is 29 Sep.
    expect(due.toISOString().slice(0, 10)).toBe('2026-09-29')
  })
})

describe('is this account due on a given day', () => {
  const weekly = { frequency: 'WEEKLY' as const, dayOfWeek: 'TUESDAY' as const }

  it('is not due on the wrong weekday', () => {
    expect(isDueOn({ ...weekly, lastServicedOn: d('2026-09-08') }, d('2026-09-16'))).toBe(false)
  })

  it('is due a week after the last visit', () => {
    expect(isDueOn({ ...weekly, lastServicedOn: d('2026-09-08') }, d('2026-09-15'))).toBe(true)
  })

  it('is not due again the same week', () => {
    expect(isDueOn({ ...weekly, lastServicedOn: d('2026-09-15') }, d('2026-09-15'))).toBe(false)
  })

  it('still counts as due when it was missed', () => {
    // Missed for a month; it should turn up on the next run, not wait out the
    // rest of its cycle.
    const fortnightly = { frequency: 'BIWEEKLY' as const, dayOfWeek: 'TUESDAY' as const }
    expect(isDueOn({ ...fortnightly, lastServicedOn: d('2026-08-04') }, d('2026-09-15'))).toBe(true)
  })

  it('is due on its first matching day when never serviced', () => {
    expect(isDueOn(weekly, d('2026-09-15'))).toBe(true)
    expect(isDueOn(weekly, d('2026-09-16'))).toBe(false)
  })

  it('holds a fortnightly account back on its off week', () => {
    const fortnightly = { frequency: 'BIWEEKLY' as const, dayOfWeek: 'TUESDAY' as const }
    expect(isDueOn({ ...fortnightly, lastServicedOn: d('2026-09-15') }, d('2026-09-22'))).toBe(false)
    expect(isDueOn({ ...fortnightly, lastServicedOn: d('2026-09-15') }, d('2026-09-29'))).toBe(true)
  })
})

describe('overdue', () => {
  it('reports nothing for an account that is on schedule', () => {
    expect(
      daysOverdue(
        { frequency: 'WEEKLY', dayOfWeek: 'TUESDAY', lastServicedOn: d('2026-09-15') },
        d('2026-09-16'),
      ),
    ).toBe(0)
  })

  it('counts the days past due', () => {
    expect(
      daysOverdue(
        { frequency: 'WEEKLY', dayOfWeek: 'TUESDAY', lastServicedOn: d('2026-09-01') },
        d('2026-09-16'),
      ),
    ).toBe(8)
  })
})

describe('describing a frequency', () => {
  it('reads as a person would say it', () => {
    expect(describeFrequency('WEEKLY')).toBe('Weekly')
    expect(describeFrequency('BIWEEKLY')).toBe('Every two weeks')
    expect(describeFrequency('CUSTOM', 10)).toBe('Every 10 days')
  })
})
