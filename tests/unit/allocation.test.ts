import { describe, expect, it } from 'vitest'
import {
  AllocationError,
  agingBucket,
  allocateOldestFirst,
  allocateSpecific,
  assertAllocationIdentity,
  summarizeAging,
} from '@/server/domain/allocation'
import { toAmountString } from '@/server/domain/money'

const invoice = (saleId: string, balanceDue: string, day: string) => ({
  saleId,
  balanceDue,
  dueDate: new Date(`${day}T00:00:00Z`),
  occurredAt: new Date(`${day}T00:00:00Z`),
})

describe('oldest first', () => {
  const open = [
    invoice('newest', '300.00', '2026-09-10'),
    invoice('oldest', '200.00', '2026-08-01'),
    invoice('middle', '150.00', '2026-08-20'),
  ]

  it('clears the oldest debt first', () => {
    const result = allocateOldestFirst('250.00', open)
    expect(result.allocations.map((a) => [a.saleId, toAmountString(a.amount)])).toEqual([
      ['oldest', '200.00'],
      ['middle', '50.00'],
    ])
    expect(toAmountString(result.unapplied)).toBe('0.00')
  })

  it('leaves a balance when the payment is short', () => {
    // The spec's example: a $500 sale paid $200 leaves $300.
    const result = allocateOldestFirst('200.00', [invoice('s', '500.00', '2026-09-01')])
    expect(toAmountString(result.allocations[0].amount)).toBe('200.00')
    expect(toAmountString(result.unapplied)).toBe('0.00')
  })

  it('keeps an over-payment as credit on account', () => {
    const result = allocateOldestFirst('1000.00', open)
    expect(toAmountString(result.unapplied)).toBe('350.00')
    assertAllocationIdentity('1000.00', result)
  })

  it('ignores invoices with nothing outstanding', () => {
    const result = allocateOldestFirst('100.00', [
      invoice('paid', '0.00', '2026-08-01'),
      invoice('owing', '100.00', '2026-09-01'),
    ])
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0].saleId).toBe('owing')
  })

  it('does nothing with nothing to pay', () => {
    const result = allocateOldestFirst('100.00', [])
    expect(result.allocations).toEqual([])
    expect(toAmountString(result.unapplied)).toBe('100.00')
  })

  it('always accounts for every cent', () => {
    for (const amount of ['0.01', '199.99', '650.00', '1234.56']) {
      const result = allocateOldestFirst(amount, open)
      expect(() => assertAllocationIdentity(amount, result)).not.toThrow()
    }
  })
})

describe('specific allocation', () => {
  const open = [invoice('a', '200.00', '2026-08-01'), invoice('b', '300.00', '2026-09-01')]

  it('applies exactly what was asked for', () => {
    const result = allocateSpecific('250.00', [
      { saleId: 'a', amount: '100.00' },
      { saleId: 'b', amount: '150.00' },
    ], open)
    expect(result.allocations).toHaveLength(2)
    expect(toAmountString(result.unapplied)).toBe('0.00')
  })

  it('refuses to apply more than an invoice owes', () => {
    expect(() =>
      allocateSpecific('500.00', [{ saleId: 'a', amount: '400.00' }], open),
    ).toThrow(AllocationError)
  })

  it('refuses allocations adding up to more than the payment', () => {
    expect(() =>
      allocateSpecific('100.00', [
        { saleId: 'a', amount: '100.00' },
        { saleId: 'b', amount: '100.00' },
      ], open),
    ).toThrow(/more than the payment/i)
  })

  it('refuses an invoice that is not open', () => {
    expect(() =>
      allocateSpecific('50.00', [{ saleId: 'ghost', amount: '50.00' }], open),
    ).toThrow(/nothing outstanding/i)
  })

  it('leaves the remainder unapplied', () => {
    const result = allocateSpecific('300.00', [{ saleId: 'a', amount: '200.00' }], open)
    expect(toAmountString(result.unapplied)).toBe('100.00')
    assertAllocationIdentity('300.00', result)
  })
})

describe('aging', () => {
  const asOf = new Date('2026-09-17T00:00:00Z')

  it('buckets by how far past due', () => {
    expect(agingBucket(new Date('2026-09-30T00:00:00Z'), asOf)).toBe('CURRENT')
    expect(agingBucket(new Date('2026-09-17T00:00:00Z'), asOf)).toBe('CURRENT')
    expect(agingBucket(new Date('2026-09-01T00:00:00Z'), asOf)).toBe('D1_30')
    expect(agingBucket(new Date('2026-08-01T00:00:00Z'), asOf)).toBe('D31_60')
    expect(agingBucket(new Date('2026-07-01T00:00:00Z'), asOf)).toBe('D61_90')
    expect(agingBucket(new Date('2026-01-01T00:00:00Z'), asOf)).toBe('D90_PLUS')
  })

  it('totals each bucket', () => {
    const totals = summarizeAging(
      [
        { balanceDue: '100.00', dueDate: new Date('2026-09-30T00:00:00Z') },
        { balanceDue: '250.50', dueDate: new Date('2026-09-01T00:00:00Z') },
        { balanceDue: '49.50', dueDate: new Date('2026-09-05T00:00:00Z') },
      ],
      asOf,
    )
    expect(toAmountString(totals.CURRENT)).toBe('100.00')
    expect(toAmountString(totals.D1_30)).toBe('300.00')
    expect(toAmountString(totals.D90_PLUS)).toBe('0.00')
  })
})
