/**
 * Reporting (spec §29–§34, docs/06 phase 7).
 *
 * Three rules shape every module in this folder.
 *
 * **1. Reports read posted transactions.** There is no reporting table, no
 * nightly rollup, no counter incremented on write. A figure in a report is
 * derived from `sale`, `sale_item`, `payment` and `inventory_transaction_line`
 * at the moment it is asked for. Maintaining a second set of totals is the
 * classic way a system starts telling two stories about the same month, and the
 * volumes here — an independent distributor writes thousands of sales a year,
 * not millions — do not come close to needing one. The one cache that exists,
 * `inventory_balance`, is provably equal to the ledger and is asserted to be so
 * by `findBalanceDrift` (docs/02 §L3).
 *
 * **2. Every financial report states what it measures.** `definition` is not
 * decoration: "profit" means half a dozen different numbers to half a dozen
 * people, and a distributor who mistakes gross profit for net profit will
 * misprice a route. The definition travels with the report into the CSV, the
 * spreadsheet and the PDF.
 *
 * **3. Money is decimal strings, end to end.** Aggregation happens in Postgres
 * `numeric`, is cast to text before it crosses into JavaScript, and is formatted
 * only at the edge (docs/02 §M1). No report multiplies a price by a quantity in
 * a double.
 */

export type ReportKey =
  | 'sales'
  | 'gross-profit'
  | 'customers'
  | 'inventory'
  | 'routes'
  | 'runners'
  | 'aging'

/** How a column is formatted and whether it is summable. */
export type ColumnFormat = 'text' | 'money' | 'number' | 'percent' | 'date'

export type ReportColumn = {
  key: string
  label: string
  format: ColumnFormat
  /** Shown on a phone; the rest collapse into the row's secondary line. */
  primary?: boolean
  /** Short help shown under the column heading on desktop. */
  hint?: string
}

export type ReportRow = Record<string, string | number | null>

export type ReportFilters = {
  /** Calendar days in the organization's zone, inclusive. */
  from: string
  to: string
  routeTemplateId?: string
  runnerUserId?: string
  customerId?: string
  productId?: string
  categoryId?: string
  /** Report-specific dimension, e.g. sales grouped by day or by product. */
  groupBy?: string
}

export type ReportResult = {
  key: ReportKey
  title: string
  /** Exactly what the numbers mean. Travels into every export. */
  definition: string
  columns: ReportColumn[]
  rows: ReportRow[]
  /** Summed over the whole result, not the visible page. */
  totals: ReportRow | null
  /** Caveats worth printing next to the figures. */
  notes: string[]
  filters: ReportFilters
  /** Human-readable filter summary for the export header. */
  appliedTo: string
  currency: string
  timeZone: string
  generatedAt: string
}

export type ReportDefinition = {
  key: ReportKey
  title: string
  summary: string
  /** Permission a viewer must hold. Money-bearing reports need the stronger one. */
  permission: 'report:read' | 'report:financial'
  /** Which filter controls to offer. */
  supports: {
    route?: boolean
    runner?: boolean
    customer?: boolean
    product?: boolean
    category?: boolean
    groupBy?: { key: string; label: string }[]
  }
}
