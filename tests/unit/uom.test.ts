import { describe, expect, it } from 'vitest'
import {
  formatQuantity,
  formatQuantityLong,
  splitQuantity,
  toBaseUnits,
  UomError,
} from '@/server/domain/uom'

describe('units of measure', () => {
  it('converts a package quantity into base units', () => {
    expect(toBaseUnits(3, 12)).toBe(36)
    expect(toBaseUnits(1, 1)).toBe(1)
    expect(toBaseUnits(2, 24)).toBe(48)
  })

  it('refuses a fractional case, which cannot exist in a ledger of integers', () => {
    expect(() => toBaseUnits(1.5, 12)).toThrow(UomError)
    expect(() => toBaseUnits(1, 0)).toThrow(UomError)
    expect(() => toBaseUnits(1, 2.5)).toThrow(UomError)
  })

  it('represents a partial case rather than forcing whole cases', () => {
    // The state the spec calls for: 18 cases + 7 individual bags.
    expect(splitQuantity(223, 12)).toEqual({ packages: 18, remainder: 7 })
    expect(formatQuantity(223, 12)).toBe('18 cs 7 ea')
  })

  it('formats the tidy cases too', () => {
    expect(formatQuantity(216, 12)).toBe('18 cs')
    expect(formatQuantity(7, 12)).toBe('7 ea')
    expect(formatQuantity(0, 12)).toBe('0')
    expect(formatQuantity(5, 1)).toBe('5 ea')
  })

  it('keeps the sign coherent when stock has gone negative', () => {
    expect(splitQuantity(-223, 12)).toEqual({ packages: -18, remainder: -7 })
    expect(formatQuantity(-223, 12)).toBe('-18 cs -7 ea')
  })

  it('pluralises the long form for desktop tables', () => {
    expect(formatQuantityLong(223, 12, { package: 'case', unit: 'bag' })).toBe('18 cases, 7 bags')
    expect(formatQuantityLong(13, 12, { package: 'case', unit: 'bag' })).toBe('1 case, 1 bag')
    expect(formatQuantityLong(24, 12, { package: 'box', unit: 'bar' })).toBe('2 boxes')
  })

  it('survives a round trip through base units', () => {
    for (const factor of [1, 6, 12, 15, 24, 36, 48]) {
      for (const cases of [0, 1, 7, 18, 200]) {
        const base = toBaseUnits(cases, factor)
        expect(splitQuantity(base, factor)).toEqual({ packages: cases, remainder: 0 })
      }
    }
  })
})
