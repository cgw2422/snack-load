import { describe, expect, it } from 'vitest'
import {
  distributeProportionally,
  formatMoney,
  m,
  round2,
  round6,
  sum,
  toAmountString,
} from '@/server/domain/money'

describe('money', () => {
  it('does not inherit binary floating-point error', () => {
    // The whole reason this layer exists: 0.1 + 0.2 !== 0.3 in a JS number.
    expect(m('0.1').plus(m('0.2')).toString()).toBe('0.3')
    expect(m(0.1).plus(m(0.2)).equals(m('0.3'))).toBe(true)
  })

  it('sums a long receipt exactly', () => {
    const lines = Array.from({ length: 40 }, () => '19.51')
    expect(toAmountString(sum(lines))).toBe('780.40')
  })

  it('rounds half up, the way a person expects', () => {
    expect(round2('1.005').toFixed(2)).toBe('1.01')
    expect(round2('2.675').toFixed(2)).toBe('2.68')
    expect(round2('-1.005').toFixed(2)).toBe('-1.01')
  })

  it('keeps six decimals on a divided unit cost', () => {
    // $19.99 per case of 12 is 1.665833…; truncating to cents drifts COGS.
    expect(round6(m('19.99').dividedBy(12)).toFixed(6)).toBe('1.665833')
  })

  it('accepts a number only at the edge, via its string form', () => {
    expect(m(19.5).toString()).toBe('19.5')
    expect(m(0).isZero()).toBe(true)
    expect(m(null).isZero()).toBe(true)
    expect(m(undefined).isZero()).toBe(true)
  })

  describe('distributeProportionally', () => {
    it('makes the parts sum exactly to the whole', () => {
      const parts = distributeProportionally('10.00', ['33.33', '33.33', '33.34'])
      expect(toAmountString(sum(parts))).toBe('10.00')
    })

    it('gives the rounding remainder to the largest line', () => {
      const parts = distributeProportionally('1.00', ['1', '1', '1'])
      expect(parts.map((p) => p.toFixed(2))).toEqual(['0.34', '0.33', '0.33'])
      expect(toAmountString(sum(parts))).toBe('1.00')
    })

    it('handles a lopsided split without losing a cent', () => {
      const parts = distributeProportionally('57.19', ['1200.00', '3.75', '0.99'])
      expect(toAmountString(sum(parts))).toBe('57.19')
    })

    it('returns zeros when there is nothing to spread', () => {
      expect(distributeProportionally('0', ['5', '5']).map(String)).toEqual(['0', '0'])
      expect(distributeProportionally('10', ['0', '0']).map(String)).toEqual(['0', '0'])
    })
  })

  it('formats for display without being used for arithmetic', () => {
    expect(formatMoney('1482.3')).toBe('$1,482.30')
    expect(formatMoney('0')).toBe('$0.00')
    expect(formatMoney('-58.5')).toBe('-$58.50')
  })
})
