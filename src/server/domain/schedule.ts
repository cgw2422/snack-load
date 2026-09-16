/**
 * Recurring service schedules (spec §12).
 *
 * "14 accounts due Tuesday" has to be answerable without walking every past
 * visit, so due dates are derived from the schedule plus the last service date.
 * Pure and date-only: a service date is a calendar day, never an instant.
 */

export type Frequency = 'WEEKLY' | 'BIWEEKLY' | 'TRIWEEKLY' | 'MONTHLY' | 'CUSTOM'

export type DayName =
  | 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY'

const DAY_INDEX: Record<DayName, number> = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
}

export const DAY_NAMES: DayName[] = [
  'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY',
]

/** Days between visits. MONTHLY is handled by calendar month, not by this. */
const CYCLE_DAYS: Record<Exclude<Frequency, 'MONTHLY' | 'CUSTOM'>, number> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
  TRIWEEKLY: 21,
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

/** The next occurrence of `day` on or after `from`. */
export function nextDayOfWeek(from: Date, day: DayName): Date {
  const target = DAY_INDEX[day]
  const delta = (target - from.getUTCDay() + 7) % 7
  return addDays(from, delta)
}

export type ScheduleShape = {
  frequency: Frequency
  dayOfWeek: DayName
  /** Only for CUSTOM. */
  intervalDays?: number | null
  lastServicedOn?: Date | null
}

/**
 * When this account is next due.
 *
 * A never-serviced account is due at its next matching weekday — a new customer
 * should appear on the very next run, not a fortnight later. After that the
 * cycle counts from the last visit, so a missed week does not push the account
 * permanently off its day.
 */
export function nextDueDate(schedule: ScheduleShape, today: Date): Date {
  if (!schedule.lastServicedOn) return nextDayOfWeek(today, schedule.dayOfWeek)

  if (schedule.frequency === 'MONTHLY') {
    const next = new Date(schedule.lastServicedOn)
    next.setUTCMonth(next.getUTCMonth() + 1)
    // Snap back onto the account's weekday, which is what "monthly on a
    // Tuesday" means to the person driving it.
    return nextDayOfWeek(next, schedule.dayOfWeek)
  }

  const cycle =
    schedule.frequency === 'CUSTOM'
      ? Math.max(1, schedule.intervalDays ?? 7)
      : CYCLE_DAYS[schedule.frequency]

  return nextDayOfWeek(addDays(schedule.lastServicedOn, cycle), schedule.dayOfWeek)
}

/**
 * Is this account due on that date?
 *
 * Overdue counts as due: an account missed last week should turn up on the next
 * run rather than waiting out its whole cycle. That is the behaviour a
 * distributor expects, and the alternative loses them a visit.
 */
export function isDueOn(schedule: ScheduleShape, serviceDate: Date): boolean {
  if (DAY_NAMES[serviceDate.getUTCDay()] !== schedule.dayOfWeek) return false
  if (!schedule.lastServicedOn) return true

  const due = nextDueDate(schedule, schedule.lastServicedOn)
  return due.getTime() <= serviceDate.getTime()
}

export function describeFrequency(frequency: Frequency, intervalDays?: number | null): string {
  switch (frequency) {
    case 'WEEKLY':
      return 'Weekly'
    case 'BIWEEKLY':
      return 'Every two weeks'
    case 'TRIWEEKLY':
      return 'Every three weeks'
    case 'MONTHLY':
      return 'Monthly'
    case 'CUSTOM':
      return intervalDays ? `Every ${intervalDays} days` : 'Custom'
  }
}

/** How overdue an account is, for sorting the planner's "due" list. */
export function daysOverdue(schedule: ScheduleShape, asOf: Date): number {
  if (!schedule.lastServicedOn) return 0
  const due = nextDueDate(schedule, schedule.lastServicedOn)
  const diff = asOf.getTime() - due.getTime()
  return diff <= 0 ? 0 : Math.floor(diff / 86_400_000)
}
