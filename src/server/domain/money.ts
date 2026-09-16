import { Decimal } from 'decimal.js'

/**
 * Money (docs/02 §M1–M2).
 *
 * Money is never a JavaScript `number`. It is a Postgres `numeric` at rest, a
 * decimal string on the wire, and a Decimal in arithmetic. `parseFloat` and
 * `Number()` are never applied to a monetary value: 0.1 + 0.2 across forty line
 * items a day is how a distributor's balances stop matching QuickBooks.
 */

/** Half-up is what a person expects, and what QuickBooks does on line extensions. */
export const Money = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
})

export type MoneyInput = string | number | Decimal | { toString(): string }

/**
 * `number` is accepted only at the edge, where a value has come from JSON or a
 * form field and has not yet been through arithmetic. It is converted via its
 * string form so a literal like 19.5 becomes exactly "19.5".
 */
export function m(value: MoneyInput | null | undefined): Decimal {
  if (value === null || value === undefined) return new Money(0)
  if (value instanceof Decimal) return new Money(value)
  return new Money(typeof value === 'number' ? value.toString() : value.toString())
}

export const ZERO = m(0)

/** Round to cents. The only rounding the money layer performs. */
export function round2(value: MoneyInput): Decimal {
  return m(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
}

/** Round to the 6dp used by unit costs, which are divided and so rarely exact. */
export function round6(value: MoneyInput): Decimal {
  return m(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
}

export function sum(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(m(v)), new Money(0))
}

/** Serialize for a DTO: always 2dp, always a string. */
export function toAmountString(value: MoneyInput): string {
  return round2(value).toFixed(2)
}

/** Serialize a unit cost for a DTO: 6dp so no precision is lost in transit. */
export function toCostString(value: MoneyInput): string {
  return round6(value).toFixed(6)
}

export function isNegative(value: MoneyInput): boolean {
  return m(value).isNegative()
}

export function maxMoney(a: MoneyInput, b: MoneyInput): Decimal {
  const da = m(a)
  const db = m(b)
  return da.greaterThan(db) ? da : db
}

export function minMoney(a: MoneyInput, b: MoneyInput): Decimal {
  const da = m(a)
  const db = m(b)
  return da.lessThan(db) ? da : db
}

/**
 * Distribute a document-level amount across weighted lines so that the parts sum
 * exactly to the whole (docs/02 §M3). The rounding remainder goes to the largest
 * weight, which is the line least distorted by absorbing it.
 */
export function distributeProportionally(total: MoneyInput, weights: MoneyInput[]): Decimal[] {
  const amount = round2(total)
  const w = weights.map(m)
  const weightTotal = sum(w)

  if (weightTotal.isZero() || amount.isZero()) return w.map(() => new Money(0))

  const parts = w.map((weight) => round2(amount.times(weight).dividedBy(weightTotal)))
  const drift = amount.minus(sum(parts))

  if (!drift.isZero()) {
    let largest = 0
    for (let i = 1; i < w.length; i++) if (w[i].greaterThan(w[largest])) largest = i
    parts[largest] = parts[largest].plus(drift)
  }
  return parts
}

/** Display formatting. Presentation only — never feed this back into arithmetic. */
export function formatMoney(value: MoneyInput, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(round2(value).toFixed(2)))
}

/** Compact form for dashboard tiles: $42,882 → "$42.9k". */
export function formatMoneyCompact(value: MoneyInput, currency = 'USD'): string {
  const d = round2(value)
  const abs = d.abs()
  if (abs.lessThan(10_000)) return formatMoney(d, currency)
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number(d.toFixed(2)))
}
