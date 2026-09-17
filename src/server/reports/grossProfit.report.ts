import { Prisma } from '@/generated/prisma/client'
import type { AuthContext } from '@/server/auth/context'
import { m, round2, toAmountString } from '@/server/domain/money'
import {
  creditItemPredicate,
  describeFilters,
  itemPredicate,
  postedCreditsPredicate,
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
    creditSelect: Prisma.sql`ci.description_snapshot`,
    creditJoin: Prisma.empty,
  },
  brand: {
    label: 'Brand',
    select: Prisma.sql`COALESCE(p.brand, 'Unbranded')`,
    join: Prisma.sql`LEFT JOIN product p ON p.id = i.product_id`,
    creditSelect: Prisma.sql`COALESCE(cp.brand, 'Unbranded')`,
    creditJoin: Prisma.sql`LEFT JOIN product cp ON cp.id = ci.product_id`,
  },
  category: {
    label: 'Category',
    select: Prisma.sql`COALESCE(pc.name, 'Uncategorised')`,
    join: Prisma.sql`
      LEFT JOIN product p ON p.id = i.product_id
      LEFT JOIN product_category pc ON pc.id = p.category_id`,
    creditSelect: Prisma.sql`COALESCE(cpc.name, 'Uncategorised')`,
    creditJoin: Prisma.sql`
      LEFT JOIN product cp ON cp.id = ci.product_id
      LEFT JOIN product_category cpc ON cpc.id = cp.category_id`,
  },
  customer: {
    label: 'Store',
    select: Prisma.sql`c.name`,
    join: Prisma.sql`JOIN customer c ON c.id = s.customer_id`,
    creditSelect: Prisma.sql`cc.name`,
    creditJoin: Prisma.sql`JOIN customer cc ON cc.id = cm.customer_id`,
  },
  route: {
    label: 'Route',
    select: Prisma.sql`COALESCE(rt.name, 'No route')`,
    join: Prisma.sql`
      LEFT JOIN route r ON r.id = s.route_id
      LEFT JOIN route_template rt ON rt.id = r.route_template_id`,
    creditSelect: Prisma.sql`COALESCE(crt.name, 'No route')`,
    creditJoin: Prisma.sql`
      LEFT JOIN sale cs ON cs.id = cm.sale_id
      LEFT JOIN route cr ON cr.id = cs.route_id
      LEFT JOIN route_template crt ON crt.id = cr.route_template_id`,
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

  const [sold, credited] = await Promise.all([
    reportQuery<RawRow>(
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
      `,
    ),
    reportQuery<RawRow>(
      ctx,
      Prisma.sql`
        SELECT ${spec.creditSelect} AS label,
               COALESCE(SUM(ci.base_quantity), 0)::bigint AS units,
               COALESCE(SUM(ci.line_subtotal - ci.discount_amount), 0)::text AS net_sales,
               -- THE historical cost, frozen onto the credit line when the goods
               -- came back, not today's cost of that product (spec §21).
               COALESCE(SUM(ci.unit_cost_at_sale * ci.base_quantity), 0)::text AS cogs
          FROM credit_memo_item ci
          JOIN credit_memo cm ON cm.id = ci.credit_memo_id
          ${spec.creditJoin}
         WHERE ${postedCreditsPredicate(ctx.organizationId, range, filters)} ${creditItemPredicate(filters)}
         GROUP BY 1
      `,
    ),
  ])

  const soldBy = new Map(sold.map((row) => [row.label ?? '—', row]))
  const creditedBy = new Map(credited.map((row) => [row.label ?? '—', row]))

  const rows: ReportRow[] = [...new Set([...soldBy.keys(), ...creditedBy.keys()])]
    .map((label) => {
      const sale = soldBy.get(label)
      const credit = creditedBy.get(label)

      const grossSales = m(sale?.net_sales ?? '0')
      const returns = m(credit?.net_sales ?? '0')
      const netSales = grossSales.minus(returns)

      // A return reverses the revenue AND the cost of the goods that came back.
      // Gross profit therefore moves by the margin, not by the whole price.
      const soldCogs = m(sale?.cogs ?? '0')
      const returnedCogs = m(credit?.cogs ?? '0')
      const cogs = soldCogs.minus(returnedCogs)
      const profit = netSales.minus(cogs)

      return {
        label,
        units: Number(sale?.units ?? 0) - Number(credit?.units ?? 0),
        grossSales: toAmountString(grossSales),
        returns: toAmountString(returns),
        netSales: toAmountString(netSales),
        cogs: toAmountString(cogs),
        grossProfit: toAmountString(profit),
        margin: marginOf(netSales, profit),
      }
    })
    .sort((a, b) => Number(b.netSales) - Number(a.netSales))
    .slice(0, 500)

  const sumOf = (key: string) =>
    rows.reduce((total, row) => total.plus(m(String(row[key]))), m(0))

  const netSalesTotal = sumOf('netSales')
  const profitTotal = sumOf('grossProfit')

  const totals: ReportRow = {
    label: 'All',
    units: rows.reduce((n, r) => n + Number(r.units), 0),
    grossSales: toAmountString(sumOf('grossSales')),
    returns: toAmountString(sumOf('returns')),
    netSales: toAmountString(netSalesTotal),
    cogs: toAmountString(sumOf('cogs')),
    grossProfit: toAmountString(profitTotal),
    margin: marginOf(netSalesTotal, profitTotal),
  }

  const columns: ReportColumn[] = [
    { key: 'label', label: spec.label, format: 'text', primary: true },
    { key: 'units', label: 'Units', format: 'number', hint: 'Sold less returned' },
    {
      key: 'grossSales',
      label: 'Gross sales',
      format: 'money',
      hint: 'Merchandise after discounts, before tax',
    },
    { key: 'returns', label: 'Returns', format: 'money', hint: 'Merchandise credited back' },
    { key: 'netSales', label: 'Net sales', format: 'money' },
    { key: 'cogs', label: 'COGS', format: 'money', hint: 'Cost frozen at the sale, less returns' },
    { key: 'grossProfit', label: 'Gross profit', format: 'money', primary: true },
    { key: 'margin', label: 'Margin', format: 'percent', hint: 'Gross profit ÷ net sales' },
  ]

  return {
    key: 'gross-profit',
    title: `Gross profit by ${spec.label.toLowerCase()}`,
    definition:
      'GROSS profit, not net. Net sales (gross merchandise after discounts, ' +
      'excluding sales tax, less merchandise credited back on returns) less the ' +
      'cost of goods sold. COGS is the moving-average unit cost frozen onto each ' +
      'line when the stock left, and a return reverses THAT cost — not today\'s — ' +
      'so a sale of $20 that cost $12 and is fully returned moves revenue by ' +
      '-$20, COGS by -$12 and gross profit by -$8. A later supplier price change ' +
      'does not restate a closed month. Nothing operational is deducted: no fuel, ' +
      'wages, vehicle costs, rent, insurance or shrinkage. Margin is gross profit ' +
      'divided by net sales.',
    columns,
    rows,
    totals,
    notes: [
      'Sales tax is excluded from net sales — it is collected for the state, not earned.',
      'Operating costs are not deducted. This is not net profit and must not be read as one.',
      'A credit with no goods behind it (a pricing correction) reverses revenue but no cost, so it reduces margin.',
      'Goods written off after a damaged return are shrinkage, which this report does not deduct.',
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
