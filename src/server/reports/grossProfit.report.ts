import { Prisma } from '@/generated/prisma/client'
import type { AuthContext } from '@/server/auth/context'
import { m, round2, toAmountString } from '@/server/domain/money'
import {
  describeFilters,
  itemPredicate,
  postedSalesPredicate,
  reportQuery,
  resolveRange,
} from './filters'
import type { ReportColumn, ReportFilters, ReportResult, ReportRow } from './types'

/**
 * Gross profit (spec §30).
 *
 * The name is the point. This is revenue less the cost of the goods that left
 * the truck, and nothing else: no fuel, no wages, no insurance, no depreciation
 * on the van. A distributor who reads this as "profit" and prices a route
 * against it will lose money on every stop while the report says they are up.
 * So the word "profit" never appears here unqualified, and the definition says
 * what is excluded before it says what is included.
 *
 * COGS comes from `unit_cost_at_sale`, the moving-average cost frozen onto the
 * line when the stock left. A later price change from a supplier does not
 * restate a closed month (docs/02 §L5).
 */

const GROUPINGS = {
  product: {
    label: 'Product',
    select: Prisma.sql`i.product_name_snapshot`,
    join: Prisma.empty,
  },
  brand: {
    label: 'Brand',
    select: Prisma.sql`COALESCE(p.brand, 'Unbranded')`,
    join: Prisma.sql`LEFT JOIN product p ON p.id = i.product_id`,
  },
  category: {
    label: 'Category',
    select: Prisma.sql`COALESCE(pc.name, 'Uncategorised')`,
    join: Prisma.sql`
      LEFT JOIN product p ON p.id = i.product_id
      LEFT JOIN product_category pc ON pc.id = p.category_id`,
  },
  customer: {
    label: 'Store',
    select: Prisma.sql`c.name`,
    join: Prisma.sql`JOIN customer c ON c.id = s.customer_id`,
  },
  route: {
    label: 'Route',
    select: Prisma.sql`COALESCE(rt.name, 'No route')`,
    join: Prisma.sql`
      LEFT JOIN route r ON r.id = s.route_id
      LEFT JOIN route_template rt ON rt.id = r.route_template_id`,
  },
} as const

export type ProfitGrouping = keyof typeof GROUPINGS

type RawRow = {
  label: string | null
  units: bigint
  net_sales: string | null
  cogs: string | null
}

export async function runGrossProfitReport(
  ctx: AuthContext,
  filters: ReportFilters,
): Promise<ReportResult> {
  const timeZone = ctx.organization.timezone
  const range = resolveRange(filters, timeZone)
  const grouping = (filters.groupBy ?? 'product') as ProfitGrouping
  const spec = GROUPINGS[grouping] ?? GROUPINGS.product

  const raw = await reportQuery<RawRow>(
    ctx,
    Prisma.sql`
      SELECT ${spec.select} AS label,
             COALESCE(SUM(i.base_quantity), 0)::bigint AS units,
             -- Merchandise only. Tax is collected for the state, never revenue,
             -- and including it would inflate every margin on this page.
             COALESCE(SUM(i.line_subtotal - i.discount_amount), 0)::text AS net_sales,
             COALESCE(SUM(i.unit_cost_at_sale * i.base_quantity), 0)::text AS cogs
        FROM sale_item i
        JOIN sale s ON s.id = i.sale_id
        ${spec.join}
       WHERE ${postedSalesPredicate(ctx.organizationId, range, filters)} ${itemPredicate(filters)}
       GROUP BY 1
       -- Numeric, not the ::text ordinal: see the note in sales.report.ts.
       ORDER BY SUM(i.line_subtotal - i.discount_amount) DESC
       LIMIT 500
    `,
  )

  const rows: ReportRow[] = raw.map((row) => {
    const netSales = m(row.net_sales ?? '0')
    const cogs = m(row.cogs ?? '0')
    const profit = netSales.minus(cogs)

    return {
      label: row.label ?? '—',
      units: Number(row.units),
      netSales: toAmountString(netSales),
      cogs: toAmountString(cogs),
      grossProfit: toAmountString(profit),
      margin: marginOf(netSales, profit),
    }
  })

  const netSalesTotal = rows.reduce((total, r) => total.plus(m(String(r.netSales))), m(0))
  const cogsTotal = rows.reduce((total, r) => total.plus(m(String(r.cogs))), m(0))
  const profitTotal = netSalesTotal.minus(cogsTotal)

  const totals: ReportRow = {
    label: 'All',
    units: rows.reduce((n, r) => n + Number(r.units), 0),
    netSales: toAmountString(netSalesTotal),
    cogs: toAmountString(cogsTotal),
    grossProfit: toAmountString(profitTotal),
    margin: marginOf(netSalesTotal, profitTotal),
  }

  const columns: ReportColumn[] = [
    { key: 'label', label: spec.label, format: 'text', primary: true },
    { key: 'units', label: 'Units', format: 'number' },
    {
      key: 'netSales',
      label: 'Net sales',
      format: 'money',
      hint: 'Merchandise after discounts, before tax',
    },
    { key: 'cogs', label: 'COGS', format: 'money', hint: 'Cost frozen at the sale' },
    { key: 'grossProfit', label: 'Gross profit', format: 'money', primary: true },
    { key: 'margin', label: 'Margin', format: 'percent', hint: 'Gross profit ÷ net sales' },
  ]

  return {
    key: 'gross-profit',
    title: `Gross profit by ${spec.label.toLowerCase()}`,
    definition:
      'GROSS profit, not net. Net sales (merchandise after discounts, excluding ' +
      'sales tax) less the cost of goods sold. COGS is the moving-average unit ' +
      'cost frozen onto each line when the stock left, so a later supplier price ' +
      'change does not restate a closed month. Nothing operational is deducted: ' +
      'no fuel, wages, vehicle costs, rent, insurance or shrinkage. Margin is ' +
      'gross profit divided by net sales.',
    columns,
    rows,
    totals,
    notes: [
      'Sales tax is excluded from net sales — it is collected for the state, not earned.',
      'Operating costs are not deducted. This is not net profit and must not be read as one.',
      'Lines sold before a product had a cost on file contribute zero COGS and overstate margin.',
    ],
    filters: { ...filters, from: range.from, to: range.to, groupBy: grouping },
    appliedTo: await describeFilters(ctx, filters, range),
    currency: ctx.organization.currency,
    timeZone,
    generatedAt: new Date().toISOString(),
  }
}

/** Margin on zero sales is undefined, not zero, and is shown as a dash. */
function marginOf(netSales: ReturnType<typeof m>, profit: ReturnType<typeof m>): string | null {
  if (netSales.isZero()) return null
  return round2(profit.dividedBy(netSales).times(100)).toFixed(2)
}
