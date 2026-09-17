import { m } from './money'

/**
 * The tax regime a document was posted under, frozen onto the document.
 *
 * The rule this exists to enforce (docs/02 §M4): **reconstructing an old
 * transaction never reads today's settings.** A store that registers for an
 * exemption in March, a rate that goes from 7.25% to 7.5% in July, a product
 * that stops being taxable — none of them may change what February's invoice
 * says was charged. `Sale.taxTotal` alone cannot survive those changes, because
 * it does not say *why* the figure is what it is, and "no tax" and "exempt" are
 * different answers to an auditor and to QuickBooks.
 *
 * Stored as JSON on the header for the same reason `billToJson` is: it is read
 * whole, never filtered on, and adding a field must not mean a migration on a
 * table of posted documents. The per-line facts that reports *do* aggregate —
 * taxable, taxable amount, rate applied — are columns.
 */
export type TaxSnapshot = {
  /**
   * The `TaxRate` row in force, by id. Identity, never the display name: a
   * distributor who renames "Ohio 7.25%" to "OH Sales Tax" has not changed
   * which rate last quarter's invoices used.
   */
  rateId: string | null
  /** What that rate was called at the time. For humans reading the document. */
  name: string | null
  /** The accounting system's code for it, where the distributor set one. */
  code: string | null
  /** Where it applied: "OH", "Erie County, OH". */
  jurisdiction: string | null
  /** Fractional, as a decimal string: "0.0725". Never a float. */
  rate: string
  /** Whether the BUYER was exempt, which is why a taxable line may carry no tax. */
  exempt: boolean
  /** The certificate number that justified the exemption, as it read then. */
  exemptId: string | null
}

export type TaxRateSource = {
  id: string
  name: string
  code: string | null
  jurisdiction: string | null
  rate: unknown
} | null

export function buildTaxSnapshot(args: {
  rate: TaxRateSource
  exempt: boolean
  exemptId: string | null
}): TaxSnapshot {
  return {
    rateId: args.rate?.id ?? null,
    name: args.rate?.name ?? null,
    code: args.rate?.code ?? null,
    jurisdiction: args.rate?.jurisdiction ?? null,
    // Exempt means no rate was applied. Recording the rate that would have
    // applied alongside `exempt: true` invites somebody to multiply by it.
    rate: args.exempt ? '0' : m(args.rate?.rate ?? 0).toString(),
    exempt: args.exempt,
    exemptId: args.exemptId,
  }
}

/**
 * Reads a snapshot back off a document. Null for documents posted before the
 * snapshot existed — callers must handle that rather than invent a regime,
 * because a guess here is the exact failure this module exists to prevent.
 */
export function readTaxSnapshot(value: unknown): TaxSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.rate !== 'string' || typeof raw.exempt !== 'boolean') return null

  const text = (key: string): string | null =>
    typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : null

  return {
    rateId: text('rateId'),
    name: text('name'),
    code: text('code'),
    jurisdiction: text('jurisdiction'),
    rate: raw.rate,
    exempt: raw.exempt,
    exemptId: text('exemptId'),
  }
}
