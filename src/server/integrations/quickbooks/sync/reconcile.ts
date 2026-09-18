import { m, round2, toAmountString } from '@/server/domain/money'

/**
 * Proving the accounting copy equals ours (docs/08 §8).
 *
 * The rule from §37 and §38: if QuickBooks records a different total or a
 * different tax figure, that is **not a successful sync**. It becomes an issue
 * a human sees, because a cent of unexplained drift per invoice is a
 * reconciliation nobody can close at year end.
 *
 * This is also the one place money legitimately becomes a JavaScript number.
 * Intuit's API is JSON and its amounts are numbers; there is no wire format
 * that preserves a decimal. So the conversion happens here, at the boundary,
 * under a comparison that would catch it if it ever lost a cent — rather than
 * being scattered through the payload builders where nobody would (docs/02 §M1).
 */

/** A decimal string to the number Intuit's JSON wants. Two places, always. */
export function toQboAmount(value: string | number): number {
  return Number(round2(m(value)).toFixed(2))
}

/** And back, so the comparison happens in decimal rather than in floats. */
export function fromQboAmount(value: number | undefined | null): string {
  return toAmountString(round2(m(value ?? 0)))
}

export type ReconciliationFailure = {
  kind: 'AMOUNT_MISMATCH' | 'TAX_MISMATCH'
  message: string
}

/**
 * Exact equality to the cent. No tolerance, deliberately: a tolerance is a
 * decision to stop noticing, and the amount that slips through it is never the
 * last one.
 */
export function reconcileTotals(args: {
  document: string
  expectedTotal: string
  actualTotal: number | undefined | null
  expectedTax?: string
  actualTax?: number | undefined | null
}): ReconciliationFailure | null {
  const actualTotal = fromQboAmount(args.actualTotal)
  const expectedTotal = toAmountString(round2(m(args.expectedTotal)))

  if (args.expectedTax !== undefined) {
    const expectedTax = toAmountString(round2(m(args.expectedTax)))
    const actualTax = fromQboAmount(args.actualTax)
    if (expectedTax !== actualTax) {
      return {
        kind: 'TAX_MISMATCH',
        message:
          `${args.document}: SnackLoad charged ${expectedTax} tax, QuickBooks recorded ${actualTax}. ` +
          'QuickBooks is recalculating tax instead of accepting the historical figure — check the ' +
          'tax code mapping under Integrations, or turn off the tax override if this company is on ' +
          'Automated Sales Tax.',
      }
    }
  }

  if (expectedTotal !== actualTotal) {
    return {
      kind: 'AMOUNT_MISMATCH',
      message:
        `${args.document}: SnackLoad total is ${expectedTotal}, QuickBooks recorded ${actualTotal}. ` +
        'The accounting copy has not been accepted as correct.',
    }
  }

  return null
}
