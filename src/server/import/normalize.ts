/**
 * Coercing spreadsheet strings into the values the domain expects.
 *
 * Every function here returns `null` for "absent" rather than a zero or a false,
 * because an empty cell in an update-mode import must leave the existing value
 * alone. Conflating "blank" with "zero" is how a price-list upload wipes out
 * everyone's credit limits.
 */

export function text(value: string | undefined): string | null {
  const v = (value ?? '').trim()
  return v === '' ? null : v
}

/** "$1,234.56" · "1234.56" · "(45.00)" → "1234.56" · "-45.00" */
export function money(value: string | undefined): { ok: true; value: string } | { ok: false } | null {
  const raw = text(value)
  if (raw === null) return null

  let s = raw.replace(/[$£€\s,]/g, '')
  if (/^\(.*\)$/.test(s)) s = `-${s.slice(1, -1)}`
  if (!/^-?\d*\.?\d+$/.test(s)) return { ok: false }

  return { ok: true, value: String(Number(s).toFixed(6)).replace(/\.?0+$/, '') || '0' }
}

export function integer(value: string | undefined): { ok: true; value: number } | { ok: false } | null {
  const raw = text(value)
  if (raw === null) return null

  const s = raw.replace(/[\s,]/g, '')
  if (!/^-?\d+(\.0+)?$/.test(s)) return { ok: false }

  return { ok: true, value: Math.trunc(Number(s)) }
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'x', 't', 'active', 'enabled', 'taxable'])
const FALSE_WORDS = new Set([
  'false', 'no', 'n', '0', 'f', 'inactive', 'disabled', 'discontinued', 'closed', 'exempt-no',
])

export function boolean(
  value: string | undefined,
  /** Some columns mean the opposite of their name: "Discontinued", "Inactive". */
  inverted = false,
): { ok: true; value: boolean } | { ok: false } | null {
  const raw = text(value)
  if (raw === null) return null

  const lowered = raw.toLowerCase()
  let parsed: boolean
  if (TRUE_WORDS.has(lowered)) parsed = true
  else if (FALSE_WORDS.has(lowered)) parsed = false
  else return { ok: false }

  return { ok: true, value: inverted ? !parsed : parsed }
}

export function email(value: string | undefined): { ok: true; value: string } | { ok: false } | null {
  const raw = text(value)
  if (raw === null) return null
  const v = raw.toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? { ok: true, value: v } : { ok: false }
}

export function postalCode(
  value: string | undefined,
): { ok: true; value: string } | { ok: false } | null {
  const raw = text(value)
  if (raw === null) return null

  // Excel eats the leading zero on New England ZIPs; 1810 is 01810.
  const digits = raw.replace(/[^0-9A-Za-z-]/g, '')
  if (/^\d{1,5}$/.test(digits)) return { ok: true, value: digits.padStart(5, '0') }
  if (/^\d{5}-?\d{4}$/.test(digits)) {
    return { ok: true, value: `${digits.slice(0, 5)}-${digits.slice(-4)}` }
  }
  if (/^[A-Za-z]\d[A-Za-z]-?\d[A-Za-z]\d$/.test(digits)) {
    return { ok: true, value: digits.replace('-', ' ').toUpperCase() }
  }
  return { ok: false }
}

export function phone(value: string | undefined): string | null {
  const raw = text(value)
  if (raw === null) return null

  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  // Anything else is kept verbatim: an extension or an international number is
  // still useful to a person, and mangling it would lose information.
  return raw
}

const DAYS: Record<string, string> = {
  mon: 'MONDAY', monday: 'MONDAY', m: 'MONDAY',
  tue: 'TUESDAY', tues: 'TUESDAY', tuesday: 'TUESDAY', t: 'TUESDAY',
  wed: 'WEDNESDAY', weds: 'WEDNESDAY', wednesday: 'WEDNESDAY', w: 'WEDNESDAY',
  thu: 'THURSDAY', thur: 'THURSDAY', thurs: 'THURSDAY', thursday: 'THURSDAY', th: 'THURSDAY',
  fri: 'FRIDAY', friday: 'FRIDAY', f: 'FRIDAY',
  sat: 'SATURDAY', saturday: 'SATURDAY', sa: 'SATURDAY',
  sun: 'SUNDAY', sunday: 'SUNDAY', su: 'SUNDAY',
}

export function dayOfWeek(value: string | undefined): { ok: true; value: string } | { ok: false } | null {
  const raw = text(value)
  if (raw === null) return null
  const key = raw.toLowerCase().replace(/[^a-z]/g, '')
  const day = DAYS[key]
  return day ? { ok: true, value: day } : { ok: false }
}

export function frequency(value: string | undefined): { ok: true; value: string } | { ok: false } | null {
  const raw = text(value)
  if (raw === null) return null

  const v = raw.toLowerCase()
  if (/^(weekly|every week|1|w|7|7 days)$/.test(v)) return { ok: true, value: 'WEEKLY' }
  if (/(bi.?weekly|every other|every 2|14|2 week)/.test(v)) return { ok: true, value: 'BIWEEKLY' }
  if (/(tri.?weekly|every 3|21|3 week)/.test(v)) return { ok: true, value: 'TRIWEEKLY' }
  if (/(month|28|30)/.test(v)) return { ok: true, value: 'MONTHLY' }
  return { ok: false }
}

export function paymentTerms(
  value: string | undefined,
): { ok: true; value: string } | { ok: false } | null {
  const raw = text(value)
  if (raw === null) return null

  const v = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (/^(cod|cash|cashondelivery|prepaid|duenow|net0)$/.test(v)) return { ok: true, value: 'COD' }

  const net = v.match(/^n(?:et)?(\d+)$/)
  if (net) {
    const days = Number(net[1])
    const closest = [7, 15, 30, 60].reduce((a, b) =>
      Math.abs(b - days) < Math.abs(a - days) ? b : a,
    )
    return { ok: true, value: `NET${closest}` }
  }
  return { ok: false }
}
