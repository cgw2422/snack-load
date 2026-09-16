import { describe, expect, it } from 'vitest'
import * as n from '@/server/import/normalize'
import { suggestMapping, PRODUCT_FIELDS, CUSTOMER_FIELDS } from '@/server/import/fields'

describe('normalizing what people actually paste', () => {
  it('reads money with currency symbols, commas and parentheses', () => {
    expect(n.money('$1,234.56')).toEqual({ ok: true, value: '1234.56' })
    expect(n.money('19.50')).toEqual({ ok: true, value: '19.5' })
    expect(n.money('(45.00)')).toEqual({ ok: true, value: '-45' })
    expect(n.money(' 7 ')).toEqual({ ok: true, value: '7' })
  })

  it('tells an empty cell apart from a zero', () => {
    // In update mode a blank must leave the existing value alone, while an
    // explicit 0 must actually set zero.
    expect(n.money('')).toBeNull()
    expect(n.money(undefined)).toBeNull()
    expect(n.money('0')).toEqual({ ok: true, value: '0' })
    expect(n.integer('')).toBeNull()
    expect(n.integer('0')).toEqual({ ok: true, value: 0 })
    expect(n.boolean('')).toBeNull()
  })

  it('rejects text in a money column rather than reading it as zero', () => {
    expect(n.money('call for price')).toEqual({ ok: false })
    expect(n.money('N/A')).toEqual({ ok: false })
  })

  it('reads whole numbers, including ones Excel wrote as 12.0', () => {
    expect(n.integer('12')).toEqual({ ok: true, value: 12 })
    expect(n.integer('12.0')).toEqual({ ok: true, value: 12 })
    expect(n.integer('1,200')).toEqual({ ok: true, value: 1200 })
    expect(n.integer('12.5')).toEqual({ ok: false })
  })

  it('reads the many ways people write yes', () => {
    for (const yes of ['Yes', 'Y', 'TRUE', '1', 'x', 'Active']) {
      expect(n.boolean(yes)).toEqual({ ok: true, value: true })
    }
    for (const no of ['No', 'N', 'FALSE', '0', 'Inactive']) {
      expect(n.boolean(no)).toEqual({ ok: true, value: false })
    }
    expect(n.boolean('maybe')).toEqual({ ok: false })
  })

  it('inverts a column whose name means the opposite', () => {
    expect(n.boolean('Yes', true)).toEqual({ ok: true, value: false })
  })

  it('restores the leading zero Excel ate off a New England ZIP', () => {
    expect(n.postalCode('1810')).toEqual({ ok: true, value: '01810' })
    expect(n.postalCode('44870')).toEqual({ ok: true, value: '44870' })
    expect(n.postalCode('44870-1234')).toEqual({ ok: true, value: '44870-1234' })
    expect(n.postalCode('448701234')).toEqual({ ok: true, value: '44870-1234' })
    expect(n.postalCode('not a zip')).toEqual({ ok: false })
  })

  it('formats a ten-digit phone and leaves anything unusual alone', () => {
    expect(n.phone('5551234567')).toBe('(555) 123-4567')
    expect(n.phone('1-555-123-4567')).toBe('(555) 123-4567')
    expect(n.phone('(555) 123-4567 x12')).toBe('(555) 123-4567 x12')
  })

  it('reads a weekday however it was abbreviated', () => {
    for (const day of ['Tue', 'TUES', 'tuesday', 'T']) {
      expect(n.dayOfWeek(day)).toEqual({ ok: true, value: 'TUESDAY' })
    }
    expect(n.dayOfWeek('someday')).toEqual({ ok: false })
  })

  it('reads visit frequency from prose', () => {
    expect(n.frequency('Weekly')).toEqual({ ok: true, value: 'WEEKLY' })
    expect(n.frequency('every other week')).toEqual({ ok: true, value: 'BIWEEKLY' })
    expect(n.frequency('Every 3 weeks')).toEqual({ ok: true, value: 'TRIWEEKLY' })
    expect(n.frequency('monthly')).toEqual({ ok: true, value: 'MONTHLY' })
  })

  it('snaps payment terms to the ones we support', () => {
    expect(n.paymentTerms('COD')).toEqual({ ok: true, value: 'COD' })
    expect(n.paymentTerms('Cash on delivery')).toEqual({ ok: true, value: 'COD' })
    expect(n.paymentTerms('Net 30')).toEqual({ ok: true, value: 'NET30' })
    expect(n.paymentTerms('n15')).toEqual({ ok: true, value: 'NET15' })
    // Net 45 is not a term we model; the closest supported one is better than
    // dropping the customer's credit arrangement entirely.
    expect(n.paymentTerms('Net 45')).toEqual({ ok: true, value: 'NET30' })
  })
})

describe('suggested column mapping', () => {
  it('maps a distributor\'s own vocabulary onto ours', () => {
    const mapping = suggestMapping(
      ['Item #', 'Item Description', 'Pack Size', 'Your Cost', 'Sell Price', 'Bar Code'],
      PRODUCT_FIELDS,
    )
    expect(mapping.sku).toBe('Item #')
    expect(mapping.name).toBe('Item Description')
    expect(mapping.caseQuantity).toBe('Pack Size')
    expect(mapping.caseCost).toBe('Your Cost')
    expect(mapping.upc).toBe('Bar Code')
  })

  it('maps "Location" to Store Name, as the spec asks', () => {
    const mapping = suggestMapping(['Location', 'City', 'ST', 'Phone'], CUSTOMER_FIELDS)
    expect(mapping.name).toBe('Location')
    expect(mapping.city).toBe('City')
    expect(mapping.state).toBe('ST')
  })

  it('never claims one column for two fields', () => {
    const mapping = suggestMapping(['Name', 'Price', 'Cost'], PRODUCT_FIELDS)
    const used = Object.values(mapping)
    expect(new Set(used).size).toBe(used.length)
  })

  it('leaves a column it cannot place unmapped rather than guessing', () => {
    const mapping = suggestMapping(['Zorbulator', 'SKU'], PRODUCT_FIELDS)
    expect(Object.values(mapping)).not.toContain('Zorbulator')
    expect(mapping.sku).toBe('SKU')
  })

  it('is case and punctuation insensitive', () => {
    const mapping = suggestMapping(['  sku  ', 'PRODUCT_NAME', 'case-qty'], PRODUCT_FIELDS)
    expect(mapping.sku).toBe('  sku  ')
    expect(mapping.name).toBe('PRODUCT_NAME')
    expect(mapping.caseQuantity).toBe('case-qty')
  })
})
