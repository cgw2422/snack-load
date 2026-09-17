import { Prisma } from '@/generated/prisma/client'
import type { AuthContext } from '@/server/auth/context'
import { m, toAmountString } from '@/server/domain/money'
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
 * Sales (spec §29).
 *
 * One report with a dimension, rather than seven near-identical reports: the
 * question is always "how much did we sell", and only the grouping changes.
 */

/**
 * Both selects take the timezone so the call sites do not have to know which
 * grouping needs it; only `day` actually reads a timestamp.
 */
type Grouping = {
  label: string
  select: (timeZone: string) => Prisma.Sql
  join: Prisma.Sql
  itemLevel: boolean
  creditSelect: (timeZone: string) => Prisma.Sql
  creditJoin: Prisma.Sql
}

const GROUPINGS = {
  day: {
    label: 'Day',
    /** Rendered in the org's timezone so a 9pm sale lands on the right day. */
    select: (tz: string) => Prisma.sql`to_char(s.occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
    join: Prisma.empty,
    itemLevel: false,
    creditSelect: (tz: string) => Prisma.sql`to_char(cm.issued_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
    creditJoin: Prisma.empty,
  },
  customer: {
    label: 'Store',
    select: () => Prisma.sql`c.name`,
    join: Prisma.sql`JOIN customer c ON c.id = s.customer_id`,
    itemLevel: false,
    creditSelect: () => Prisma.sql`cc.name`,
    creditJoin: Prisma.sql`JOIN customer cc ON cc.id = cm.customer_id`,
  },
  runner: {
    label: 'Runner',
    select: () => Prisma.sql`concat_ws(' ', u.first_name, u.last_name)`,
    join: Prisma.sql`JOIN app_user u ON u.id = s.sold_by_user_id`,
    itemLevel: false,
    creditSelect: () => Prisma.sql`COALESCE(concat_ws(' ', cu.first_name, cu.last_name), 'Unattributed')`,
    creditJoin: Prisma.sql`
      LEFT JOIN sale cs ON cs.id = cm.sale_id
      LEFT JOIN app_user cu ON cu.id = cs.sold_by_user_id`,
  },
  route: {
    label: 'Route',
    select: () => Prisma.sql`COALESCE(rt.name, 'No route')`,
    join: Prisma.sql`
      LEFT JOIN route r ON r.id = s.route_id
      LEFT JOIN route_template rt ON rt.id = r.route_template_id`,
    itemLevel: false,
    creditSelect: () => Prisma.sql`COALESCE(crt.name, 'No route')`,
    creditJoin: Prisma.sql`
      LEFT JOIN sale cs ON cs.id = cm.sale_id
      LEFT JOIN route cr ON cr.id = cs.route_id
      LEFT JOIN route_template crt ON crt.id = cr.route_template_id`,
  },
  product: {
    label: 'Product',
    select: () => Prisma.sql`i.product_name_snapshot`,
    join: Prisma.empty,
    itemLevel: true,
    creditSelect: () => Prisma.sql`ci.description_snapshot`,
    creditJoin: Prisma.empty,
  },
  brand: {
    label: 'Brand',
    select: () => Prisma.sql`COALESCE(p.brand, 'Unbranded')`,
    join: Prisma.sql`LEFT JOIN product p ON p.id = i.product_id`,
    itemLevel: true,
    creditSelect: () => Prisma.sql`COALESCE(cp.brand, 'Unbranded')`,
    creditJoin: Prisma.sql`LEFT JOIN product cp ON cp.id = ci.product_id`,
  },
} as const satisfies Record<string, Grouping>

export type SalesGrouping = keyof typeof GROUPINGS

/** Item-level groupings do not read a timestamp, so nothing meaningful is passed. */
const timeZoneless = ''

export async function runSalesReport(
  ctx: AuthContext,
  filters: ReportFilters,
): Promise<ReportResult> {
  const timeZone = ctx.organization.timezone
  const range = resolveRange(filters, timeZone)
  const grouping = (filters.groupBy ?? 'day') as SalesGrouping
  const spec = GROUPINGS[grouping] ?? GROUPINGS.day

  const where = postedSalesPredicate(ctx.organizationId, range, filters)

  const [sold, credited] = await Promise.all([
    spec.itemLevel
      ? itemLevel(ctx, spec, where, filters)
      : saleLevel(ctx, spec, where, timeZone, filters),
    credits(ctx, spec, range, filters, timeZone),
  ])

  // Every label on either side gets a row, so a period with a return but no
  // sale of that product still shows the return rather than swallowing it.
  const labels = [...new Set([...sold.keys(), ...credited.keys()])]
  if (grouping === 'day') labels.sort()

  const rows: ReportRow[] = labels
    .map((label) => {
      const sale = sold.get(label)
      const credit = credited.get(label)
      const gross = m(sale?.revenue ?? '0')
      const returned = m(credit?.amount ?? '0')

      return {
        label,
        orders: sale?.orders ?? 0,
        units: sale?.units ?? 0,
        gross: toAmountString(gross),
        returns: toAmountString(returned),
        net: toAmountString(gross.minus(returned)),
        tax: toAmountString(m(sale?.tax ?? '0').minus(m(credit?.tax ?? '0'))),
        average:
          (sale?.orders ?? 0) > 0
            ? toAmountString(gross.dividedBy(sale!.orders))
            : '0.00',
      }
    })
    .sort((a, b) =>
      grouping === 'day' ? 0 : Number(b.gross) - Number(a.gross),
    )

  const sumOf = (key: string) =>
    rows.reduce((total, row) => total.plus(m(String(row[key]))), m(0))

  const grossTotal = sumOf('gross')
  const ordersTotal = rows.reduce((n, r) => n + Number(r.orders), 0)

  const totals: ReportRow = {
    label: 'All',
    orders: ordersTotal,
    units: rows.reduce((n, r) => n + Number(r.units), 0),
    gross: toAmountString(grossTotal),
    returns: toAmountString(sumOf('returns')),
    net: toAmountString(sumOf('net')),
    tax: toAmountString(sumOf('tax')),
    average: ordersTotal > 0 ? toAmountString(grossTotal.dividedBy(ordersTotal)) : '0.00',
  }

  const columns: ReportColumn[] = [
    { key: 'label', label: spec.label, format: 'text', primary: true },
    { key: 'orders', label: 'Orders', format: 'number' },
    { key: 'units', label: 'Units', format: 'number', hint: 'Base units, not cases' },
    { key: 'gross', label: 'Gross sales', format: 'money', hint: 'Invoiced, before credits' },
    { key: 'returns', label: 'Returns', format: 'money', hint: 'Credit memos issued' },
    { key: 'net', label: 'Net sales', format: 'money', primary: true },
    { key: 'tax', label: 'Tax', format: 'money', hint: 'Charged less reversed' },
    { key: 'average', label: 'Avg order', format: 'money' },
  ]

  return {
    key: 'sales',
    title: `Sales by ${spec.label.toLowerCase()}`,
    definition:
      'Gross sales is the invoiced total of completed sales — merchandise plus ' +
      'tax, less discounts — recognised on the date the sale was written, whether ' +
      'or not it has been paid for. Returns is the total of credit memos issued ' +
      'in the window, shown separately rather than quietly netted off, so a month ' +
      'that sold well and gave half of it back does not read like a good month. ' +
      'Net sales is gross less returns. Tax is what was charged less what was ' +
      'reversed. Voided sales and voided credits are excluded entirely.',
    columns,
    rows,
    totals,
    notes: [
      'Units are base units (bags, bottles, cans), not cases, and count what went out — returns are not deducted from them.',
      'A credit is counted on the day it was issued, which may be later than the sale it reverses.',
      'Revenue is billed, not collected. For cash actually received, see the runner report.',
    ],
    filters: { ...filters, from: range.from, to: range.to, groupBy: grouping },
    appliedTo: await describeFilters(ctx, filters, range),
    currency: ctx.organization.currency,
    timeZone,
    generatedAt: new Date().toISOString(),
  }
}

type SoldRow = { orders: number; units: number; revenue: string; tax: string }
type CreditRow = { amount: string; tax: string }

type RawSale = {
  label: string | null
  orders: bigint
  units: bigint
  revenue: string | null
  tax: string | null
}

async function saleLevel(
  ctx: AuthContext,
  spec: Grouping,
  where: Prisma.Sql,
  timeZone: string,
  filters: ReportFilters,
): Promise<Map<string, SoldRow>> {
  // Item-level filters still narrow a sale-level grouping: "Route A's Doritos
  // revenue" has to count only the Doritos lines, not the whole invoice.
  const rows = await reportQuery<RawSale>(
    ctx,
    Prisma.sql`
      SELECT ${spec.select(timeZone)} AS label,
             COUNT(DISTINCT s.id)::bigint AS orders,
             COALESCE(SUM(i.base_quantity), 0)::bigint AS units,
             COALESCE(SUM(i.line_total), 0)::text AS revenue,
             COALESCE(SUM(i.tax_amount), 0)::text AS tax
        FROM sale s
        ${spec.join}
        JOIN sale_item i ON i.sale_id = s.id
       WHERE ${where} ${itemPredicate(filters)}
       GROUP BY 1
    `,
  )
  return toSoldMap(rows)
}

async function itemLevel(
  ctx: AuthContext,
  spec: Grouping,
  where: Prisma.Sql,
  filters: ReportFilters,
): Promise<Map<string, SoldRow>> {
  const rows = await reportQuery<RawSale>(
    ctx,
    Prisma.sql`
      SELECT ${spec.select(timeZoneless)} AS label,
             COUNT(DISTINCT s.id)::bigint AS orders,
             COALESCE(SUM(i.base_quantity), 0)::bigint AS units,
             COALESCE(SUM(i.line_total), 0)::text AS revenue,
             COALESCE(SUM(i.tax_amount), 0)::text AS tax
        FROM sale_item i
        JOIN sale s ON s.id = i.sale_id
        ${spec.join}
       WHERE ${where} ${itemPredicate(filters)}
       GROUP BY 1
       ORDER BY SUM(i.line_total) DESC
       LIMIT 500
    `,
  )
  return toSoldMap(rows)
}

type RawCredit = { label: string | null; amount: string | null; tax: string | null }

/**
 * Credits grouped the same way as the sales they sit beside.
 *
 * Item-level groupings read the credit memo's own lines; document-level ones
 * read the memo. Both exclude voided memos.
 */
async function credits(
  ctx: AuthContext,
  spec: Grouping,
  range: ReturnType<typeof resolveRange>,
  filters: ReportFilters,
  timeZone: string,
): Promise<Map<string, CreditRow>> {
  const where = postedCreditsPredicate(ctx.organizationId, range, filters)

  const rows = spec.itemLevel
    ? await reportQuery<RawCredit>(
        ctx,
        Prisma.sql`
          SELECT ${spec.creditSelect(timeZoneless)} AS label,
                 COALESCE(SUM(ci.line_total), 0)::text AS amount,
                 COALESCE(SUM(ci.tax_amount), 0)::text AS tax
            FROM credit_memo_item ci
            JOIN credit_memo cm ON cm.id = ci.credit_memo_id
            ${spec.creditJoin}
           WHERE ${where} ${creditItemPredicate(filters)}
           GROUP BY 1
        `,
      )
    : await reportQuery<RawCredit>(
        ctx,
        Prisma.sql`
          SELECT ${spec.creditSelect(timeZone)} AS label,
                 COALESCE(SUM(cm.amount), 0)::text AS amount,
                 COALESCE(SUM(cm.tax_total), 0)::text AS tax
            FROM credit_memo cm
            ${spec.creditJoin}
           WHERE ${where}
           GROUP BY 1
        `,
      )

  return new Map(
    rows.map((row) => [
      row.label ?? '—',
      { amount: toAmountString(row.amount ?? '0'), tax: toAmountString(row.tax ?? '0') },
    ]),
  )
}

function toSoldMap(rows: RawSale[]): Map<string, SoldRow> {
  return new Map(
    rows.map((row) => [
      row.label ?? '—',
      {
        orders: Number(row.orders),
        units: Number(row.units),
        revenue: toAmountString(row.revenue ?? '0'),
        tax: toAmountString(row.tax ?? '0'),
      },
    ]),
  )
}
