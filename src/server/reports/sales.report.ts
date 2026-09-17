import { Prisma } from '@/generated/prisma/client'
import type { AuthContext } from '@/server/auth/context'
import { m, toAmountString } from '@/server/domain/money'
import {
  describeFilters,
  itemPredicate,
  postedSalesPredicate,
  reportQuery,
  resolveRange,
} from './filters'
import type { ReportColumn, ReportFilters, ReportResult, ReportRow } from './types'

/**
 * Sales (spec §29).
 *
 * One report with a dimension, rather than seven near-identical reports: the
 * question is always "how much did we sell", and only the grouping changes.
 */

const GROUPINGS = {
  day: {
    label: 'Day',
    /** Rendered in the org's timezone so a 9pm sale lands on the right day. */
    select: (tz: string) => Prisma.sql`to_char(s.occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
    join: Prisma.empty,
    itemLevel: false,
  },
  customer: {
    label: 'Store',
    select: () => Prisma.sql`c.name`,
    join: Prisma.sql`JOIN customer c ON c.id = s.customer_id`,
    itemLevel: false,
  },
  runner: {
    label: 'Runner',
    select: () => Prisma.sql`concat_ws(' ', u.first_name, u.last_name)`,
    join: Prisma.sql`JOIN app_user u ON u.id = s.sold_by_user_id`,
    itemLevel: false,
  },
  route: {
    label: 'Route',
    select: () => Prisma.sql`COALESCE(rt.name, 'No route')`,
    join: Prisma.sql`
      LEFT JOIN route r ON r.id = s.route_id
      LEFT JOIN route_template rt ON rt.id = r.route_template_id`,
    itemLevel: false,
  },
  product: {
    label: 'Product',
    select: () => Prisma.sql`i.product_name_snapshot`,
    join: Prisma.empty,
    itemLevel: true,
  },
  brand: {
    label: 'Brand',
    select: () => Prisma.sql`COALESCE(p.brand, 'Unbranded')`,
    join: Prisma.sql`LEFT JOIN product p ON p.id = i.product_id`,
    itemLevel: true,
  },
} as const

export type SalesGrouping = keyof typeof GROUPINGS

export async function runSalesReport(
  ctx: AuthContext,
  filters: ReportFilters,
): Promise<ReportResult> {
  const timeZone = ctx.organization.timezone
  const range = resolveRange(filters, timeZone)
  const grouping = (filters.groupBy ?? 'day') as SalesGrouping
  const spec = GROUPINGS[grouping] ?? GROUPINGS.day

  const where = postedSalesPredicate(ctx.organizationId, range, filters)

  const rows = spec.itemLevel
    ? await itemLevel(ctx, spec, where, filters)
    : await saleLevel(ctx, spec, where, timeZone, filters)

  const totals: ReportRow = {
    label: 'All',
    orders: rows.reduce((n, r) => n + Number(r.orders ?? 0), 0),
    units: rows.reduce((n, r) => n + Number(r.units ?? 0), 0),
    revenue: toAmountString(
      rows.reduce((total, r) => total.plus(m(String(r.revenue ?? '0'))), m(0)),
    ),
  }
  totals.average =
    Number(totals.orders) > 0
      ? toAmountString(m(String(totals.revenue)).dividedBy(Number(totals.orders)))
      : '0.00'

  const columns: ReportColumn[] = [
    { key: 'label', label: spec.label, format: 'text', primary: true },
    { key: 'orders', label: 'Orders', format: 'number' },
    { key: 'units', label: 'Units', format: 'number', hint: 'Base units, not cases' },
    { key: 'revenue', label: 'Revenue', format: 'money', primary: true },
    { key: 'average', label: 'Avg order', format: 'money' },
  ]

  return {
    key: 'sales',
    title: `Sales by ${spec.label.toLowerCase()}`,
    definition:
      'Revenue is the invoiced total of completed sales — merchandise plus tax, ' +
      'less discounts — recognised on the date the sale was written, whether or ' +
      'not it has been paid for. Voided sales are excluded entirely rather than ' +
      'netted off. Returns and credit memos are not deducted here.',
    columns,
    rows,
    totals,
    notes: [
      'Units are base units (bags, bottles, cans), not cases.',
      'Revenue is billed, not collected. For cash actually received, see the runner report.',
    ],
    filters: { ...filters, from: range.from, to: range.to, groupBy: grouping },
    appliedTo: await describeFilters(ctx, filters, range),
    currency: ctx.organization.currency,
    timeZone,
    generatedAt: new Date().toISOString(),
  }
}

type RawRow = { label: string | null; orders: bigint; units: bigint; revenue: string | null }

async function saleLevel(
  ctx: AuthContext,
  spec: (typeof GROUPINGS)[SalesGrouping],
  where: Prisma.Sql,
  timeZone: string,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  // Item-level filters still narrow a sale-level grouping: "Route A's Doritos
  // revenue" has to count only the Doritos lines, not the whole invoice.
  const itemWhere = itemPredicate(filters)

  const rows = await reportQuery<RawRow>(
    ctx,
    Prisma.sql`
      SELECT ${spec.select(timeZone)} AS label,
             COUNT(DISTINCT s.id)::bigint AS orders,
             COALESCE(SUM(i.base_quantity), 0)::bigint AS units,
             COALESCE(SUM(i.line_total), 0)::text AS revenue
        FROM sale s
        ${spec.join}
        JOIN sale_item i ON i.sale_id = s.id
       WHERE ${where} ${itemWhere}
       GROUP BY 1
       -- Revenue is cast to ::text so it never passes through a float, which
       -- makes its ordinal a lexicographic sort. Order on the numeric sum.
       ORDER BY ${spec === GROUPINGS.day ? Prisma.sql`1 ASC` : Prisma.sql`SUM(i.line_total) DESC`}
    `,
  )

  return rows.map(toRow)
}

async function itemLevel(
  ctx: AuthContext,
  spec: (typeof GROUPINGS)[SalesGrouping],
  where: Prisma.Sql,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  const rows = await reportQuery<RawRow>(
    ctx,
    Prisma.sql`
      SELECT ${spec.select('')} AS label,
             COUNT(DISTINCT s.id)::bigint AS orders,
             COALESCE(SUM(i.base_quantity), 0)::bigint AS units,
             COALESCE(SUM(i.line_total), 0)::text AS revenue
        FROM sale_item i
        JOIN sale s ON s.id = i.sale_id
        ${spec.join}
       WHERE ${where} ${itemPredicate(filters)}
       GROUP BY 1
       ORDER BY SUM(i.line_total) DESC
       LIMIT 500
    `,
  )

  return rows.map(toRow)
}

function toRow(raw: RawRow): ReportRow {
  const orders = Number(raw.orders)
  const revenue = toAmountString(raw.revenue ?? '0')
  return {
    label: raw.label ?? '—',
    orders,
    units: Number(raw.units),
    revenue,
    average: orders > 0 ? toAmountString(m(revenue).dividedBy(orders)) : '0.00',
  }
}
