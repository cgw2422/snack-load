import { Prisma } from '@/generated/prisma/client'
import type { AuthContext } from '@/server/auth/context'
import { m, round2, toAmountString } from '@/server/domain/money'
import { describeFilters, postedSalesPredicate, reportQuery, resolveRange } from './filters'
import type { ReportColumn, ReportFilters, ReportResult, ReportRow } from './types'

/**
 * Customer performance, including declining accounts (spec §31).
 *
 * The useful question is not "who buys the most" — that list never changes and
 * everyone already knows it. It is "who is buying less than they used to",
 * because a store quietly halving its order is how a distributor loses an
 * account without noticing.
 *
 * So every store is measured against **its own** immediately preceding window
 * of the same length, not against other stores and not against a company-wide
 * average. A $200-a-week corner store dropping to $90 matters exactly as much
 * as a $2,000 chain account dropping to $900, and a percentage says so while a
 * dollar ranking does not.
 */

type RawRow = {
  customer_id: string
  name: string
  account_number: string
  orders: bigint
  revenue: string | null
  last_sale: Date | null
  prior_revenue: string | null
  prior_orders: bigint
  balance: string | null
}

/** A drop this deep is worth a phone call. */
const DECLINE_THRESHOLD = -20

export async function runCustomersReport(
  ctx: AuthContext,
  filters: ReportFilters,
): Promise<ReportResult> {
  const timeZone = ctx.organization.timezone
  const range = resolveRange(filters, timeZone)

  // The comparison window is the same length, immediately before this one, so
  // a 7-day view compares against the previous 7 days and a quarter against the
  // previous quarter.
  const span = range.toDate.getTime() - range.fromDate.getTime()
  const priorFrom = new Date(range.fromDate.getTime() - span - 1)
  const priorTo = new Date(range.fromDate.getTime() - 1)

  const where = postedSalesPredicate(ctx.organizationId, range, filters)

  const raw = await reportQuery<RawRow>(
    ctx,
    Prisma.sql`
      WITH current AS (
        SELECT s.customer_id,
               COUNT(*)::bigint AS orders,
               SUM(s.total) AS revenue,
               MAX(s.occurred_at) AS last_sale
          FROM sale s
         WHERE ${where}
         GROUP BY s.customer_id
      ),
      prior AS (
        SELECT s.customer_id,
               COUNT(*)::bigint AS orders,
               SUM(s.total) AS revenue
          FROM sale s
         WHERE s.organization_id = ${ctx.organizationId}
           AND s.status = 'COMPLETED'
           AND s.occurred_at >= ${priorFrom}
           AND s.occurred_at <= ${priorTo}
         GROUP BY s.customer_id
      )
      SELECT c.id AS customer_id,
             c.name,
             c.account_number,
             COALESCE(cur.orders, 0)::bigint AS orders,
             COALESCE(cur.revenue, 0)::text AS revenue,
             cur.last_sale,
             COALESCE(pri.revenue, 0)::text AS prior_revenue,
             COALESCE(pri.orders, 0)::bigint AS prior_orders,
             c.balance::text AS balance
        FROM customer c
        LEFT JOIN current cur ON cur.customer_id = c.id
        LEFT JOIN prior pri ON pri.customer_id = c.id
       WHERE c.organization_id = ${ctx.organizationId}
         AND c.active = true
         -- A store with no history in either window is not news; it is a store
         -- that has never ordered.
         AND (cur.orders IS NOT NULL OR pri.orders IS NOT NULL)
         ${filters.customerId ? Prisma.sql`AND c.id = ${filters.customerId}` : Prisma.empty}
       ORDER BY COALESCE(cur.revenue, 0) DESC
       LIMIT 500
    `,
  )

  const rows: ReportRow[] = raw.map((row) => {
    const revenue = m(row.revenue ?? '0')
    const prior = m(row.prior_revenue ?? '0')
    const change = changePercent(prior, revenue)

    return {
      label: row.name,
      accountNumber: row.account_number,
      orders: Number(row.orders),
      revenue: toAmountString(revenue),
      priorRevenue: toAmountString(prior),
      change,
      lastSale: row.last_sale ? row.last_sale.toISOString() : null,
      balance: toAmountString(row.balance ?? '0'),
      status: statusOf(Number(row.orders), Number(row.prior_orders), change),
    }
  })

  const revenueTotal = rows.reduce((total, r) => total.plus(m(String(r.revenue))), m(0))
  const priorTotal = rows.reduce((total, r) => total.plus(m(String(r.priorRevenue))), m(0))

  const totals: ReportRow = {
    label: 'All stores',
    accountNumber: '',
    orders: rows.reduce((n, r) => n + Number(r.orders), 0),
    revenue: toAmountString(revenueTotal),
    priorRevenue: toAmountString(priorTotal),
    change: changePercent(priorTotal, revenueTotal),
    lastSale: null,
    balance: toAmountString(rows.reduce((total, r) => total.plus(m(String(r.balance))), m(0))),
    status: '',
  }

  const columns: ReportColumn[] = [
    { key: 'label', label: 'Store', format: 'text', primary: true },
    { key: 'orders', label: 'Orders', format: 'number' },
    { key: 'revenue', label: 'Revenue', format: 'money', primary: true },
    {
      key: 'priorRevenue',
      label: 'Prior period',
      format: 'money',
      hint: 'The same number of days immediately before',
    },
    { key: 'change', label: 'Change', format: 'percent', primary: true },
    { key: 'balance', label: 'Owes', format: 'money' },
    { key: 'lastSale', label: 'Last order', format: 'date' },
    { key: 'status', label: 'Status', format: 'text' },
  ]

  const declining = rows.filter((r) => r.status === 'Declining' || r.status === 'Stopped').length

  return {
    key: 'customers',
    title: 'Customers and declining accounts',
    definition:
      'Revenue is the invoiced total of completed sales in the window. Each store ' +
      'is compared with ITS OWN immediately preceding window of the same length — ' +
      'not with other stores and not with an average — so a small account losing ' +
      'half its volume shows up as clearly as a large one. "Declining" means ' +
      `revenue fell by more than ${Math.abs(DECLINE_THRESHOLD)}%. "Stopped" means the store ordered ` +
      'in the prior window and not at all in this one. Owed is the current open ' +
      'balance, which is as of today, not as of the end of the window.',
    columns,
    rows,
    totals,
    notes: [
      `${declining} ${declining === 1 ? 'account is' : 'accounts are'} declining or have stopped ordering.`,
      'Inactive accounts are excluded. Stores with no history in either window are excluded.',
      'A short window makes ordinary week-to-week variation look like a trend; compare over four weeks or more before acting.',
    ],
    filters: { ...filters, from: range.from, to: range.to },
    appliedTo: await describeFilters(ctx, filters, range),
    currency: ctx.organization.currency,
    timeZone,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Percentage change, as a string or null.
 *
 * Growth from nothing is not "infinite percent" — it is a new account, and the
 * honest answer is no percentage at all.
 */
function changePercent(prior: ReturnType<typeof m>, current: ReturnType<typeof m>): string | null {
  if (prior.isZero()) return null
  return round2(current.minus(prior).dividedBy(prior).times(100)).toFixed(2)
}

function statusOf(orders: number, priorOrders: number, change: string | null): string {
  if (orders === 0 && priorOrders > 0) return 'Stopped'
  if (priorOrders === 0) return 'New'
  if (change !== null && Number(change) <= DECLINE_THRESHOLD) return 'Declining'
  if (change !== null && Number(change) >= 20) return 'Growing'
  return 'Steady'
}
