import { Prisma } from '@/generated/prisma/client'
import type { AuthContext } from '@/server/auth/context'
import { m, round2, toAmountString } from '@/server/domain/money'
import { describeFilters, reportQuery, resolveRange } from './filters'
import type { ReportColumn, ReportFilters, ReportResult, ReportRow } from './types'

/**
 * Route and runner performance (spec §33).
 *
 * Two reports from one query shape, because they ask the same question of
 * different columns: how much work went out, how much came back as an order,
 * and how much of that came back as money.
 *
 * The distinction that matters is **billed versus collected**. A runner who
 * writes $4,000 of invoices and collects $400 has had a very different day from
 * one who writes $2,000 and collects $2,000, and a report with a single
 * "sales" column hides that completely.
 */

type RawRow = {
  label: string | null
  id: string | null
  stops: bigint
  completed_stops: bigint
  no_sale_stops: bigint
  orders: bigint
  billed: string | null
  collected: string | null
}

export async function runRoutesReport(
  ctx: AuthContext,
  filters: ReportFilters,
): Promise<ReportResult> {
  return build(ctx, filters, 'routes')
}

export async function runRunnersReport(
  ctx: AuthContext,
  filters: ReportFilters,
): Promise<ReportResult> {
  return build(ctx, filters, 'runners')
}

async function build(
  ctx: AuthContext,
  filters: ReportFilters,
  which: 'routes' | 'runners',
): Promise<ReportResult> {
  const timeZone = ctx.organization.timezone
  const range = resolveRange(filters, timeZone)
  const byRunner = which === 'runners'

  const label = byRunner
    ? Prisma.sql`concat_ws(' ', u.first_name, u.last_name)`
    : Prisma.sql`COALESCE(rt.name, 'No route')`
  const groupId = byRunner ? Prisma.sql`r.runner_user_id` : Prisma.sql`rt.id`

  const runnerFilter = filters.runnerUserId
    ? Prisma.sql`AND r.runner_user_id = ${filters.runnerUserId}`
    : Prisma.empty
  const routeFilter = filters.routeTemplateId
    ? Prisma.sql`AND r.route_template_id = ${filters.routeTemplateId}`
    : Prisma.empty

  const raw = await reportQuery<RawRow>(
    ctx,
    Prisma.sql`
      WITH runs AS (
        SELECT r.id,
               ${groupId} AS group_id,
               ${label} AS label
          FROM route r
          LEFT JOIN route_template rt ON rt.id = r.route_template_id
          LEFT JOIN app_user u ON u.id = r.runner_user_id
         WHERE r.organization_id = ${ctx.organizationId}
           AND r.service_date >= ${range.from}::date
           AND r.service_date <= ${range.to}::date
           ${runnerFilter}
           ${routeFilter}
      ),
      stops AS (
        SELECT runs.group_id,
               COUNT(*)::bigint AS stops,
               COUNT(*) FILTER (WHERE st.status = 'COMPLETED')::bigint AS completed_stops,
               COUNT(*) FILTER (WHERE st.status = 'NO_SALE')::bigint AS no_sale_stops
          FROM route_stop st
          JOIN runs ON runs.id = st.route_id
         GROUP BY runs.group_id
      ),
      sales AS (
        SELECT runs.group_id,
               COUNT(*)::bigint AS orders,
               SUM(s.total) AS billed
          FROM sale s
          JOIN runs ON runs.id = s.route_id
         WHERE s.status = 'COMPLETED'
         GROUP BY runs.group_id
      ),
      -- Money actually taken on the route, which is not the same thing as the
      -- value of the paper written on it.
      collections AS (
        SELECT runs.group_id,
               SUM(pay.amount) AS collected
          FROM payment pay
          JOIN route_stop st ON st.id = pay.route_stop_id
          JOIN runs ON runs.id = st.route_id
         WHERE pay.status = 'POSTED'
         GROUP BY runs.group_id
      )
      SELECT DISTINCT ON (runs.group_id)
             runs.group_id AS id,
             runs.label,
             COALESCE(stops.stops, 0)::bigint AS stops,
             COALESCE(stops.completed_stops, 0)::bigint AS completed_stops,
             COALESCE(stops.no_sale_stops, 0)::bigint AS no_sale_stops,
             COALESCE(sales.orders, 0)::bigint AS orders,
             COALESCE(sales.billed, 0)::text AS billed,
             COALESCE(collections.collected, 0)::text AS collected
        FROM runs
        LEFT JOIN stops ON stops.group_id = runs.group_id
        LEFT JOIN sales ON sales.group_id = runs.group_id
        LEFT JOIN collections ON collections.group_id = runs.group_id
       ORDER BY runs.group_id, COALESCE(sales.billed, 0) DESC
    `,
  )

  const rows: ReportRow[] = raw
    .map((row) => {
      const billed = m(row.billed ?? '0')
      const orders = Number(row.orders)
      const stops = Number(row.stops)

      return {
        label: row.label ?? '—',
        stops,
        completed: Number(row.completed_stops),
        noSale: Number(row.no_sale_stops),
        orders,
        billed: toAmountString(billed),
        collected: toAmountString(row.collected ?? '0'),
        averageOrder: orders > 0 ? toAmountString(billed.dividedBy(orders)) : '0.00',
        // What fraction of the stops on the sheet turned into an order.
        strikeRate: stops > 0 ? round2((orders / stops) * 100).toFixed(2) : null,
      }
    })
    .sort((a, b) => Number(b.billed) - Number(a.billed))

  const billedTotal = rows.reduce((total, r) => total.plus(m(String(r.billed))), m(0))
  const ordersTotal = rows.reduce((n, r) => n + Number(r.orders), 0)
  const stopsTotal = rows.reduce((n, r) => n + Number(r.stops), 0)

  const totals: ReportRow = {
    label: byRunner ? 'All runners' : 'All routes',
    stops: stopsTotal,
    completed: rows.reduce((n, r) => n + Number(r.completed), 0),
    noSale: rows.reduce((n, r) => n + Number(r.noSale), 0),
    orders: ordersTotal,
    billed: toAmountString(billedTotal),
    collected: toAmountString(rows.reduce((t, r) => t.plus(m(String(r.collected))), m(0))),
    averageOrder: ordersTotal > 0 ? toAmountString(billedTotal.dividedBy(ordersTotal)) : '0.00',
    strikeRate: stopsTotal > 0 ? round2((ordersTotal / stopsTotal) * 100).toFixed(2) : null,
  }

  const columns: ReportColumn[] = [
    { key: 'label', label: byRunner ? 'Runner' : 'Route', format: 'text', primary: true },
    { key: 'stops', label: 'Stops', format: 'number' },
    { key: 'completed', label: 'Completed', format: 'number' },
    { key: 'noSale', label: 'No sale', format: 'number' },
    { key: 'orders', label: 'Orders', format: 'number' },
    { key: 'billed', label: 'Billed', format: 'money', primary: true, hint: 'Invoiced on the route' },
    {
      key: 'collected',
      label: 'Collected',
      format: 'money',
      primary: true,
      hint: 'Money taken at the stop',
    },
    { key: 'averageOrder', label: 'Avg order', format: 'money' },
    { key: 'strikeRate', label: 'Orders per stop', format: 'percent' },
  ]

  return {
    key: byRunner ? 'runners' : 'routes',
    title: byRunner ? 'Runner performance' : 'Route performance',
    definition:
      'Counted over routes whose SERVICE DATE falls in the window, so a route ' +
      'written up the next morning still counts on the day it ran. Billed is the ' +
      'invoiced total of completed sales made on those routes. Collected is money ' +
      'actually received at a stop on those routes — the two differ by whatever ' +
      'went on account, and a payment mailed to the office later is not counted ' +
      'here. Orders per stop is orders divided by scheduled stops.',
    columns,
    rows,
    totals,
    notes: [
      'Billed is not collected. A large gap means the route is selling on terms, not for cash.',
      'A no-sale stop still counts as a stop: the visit happened and cost the same fuel.',
      'Payments taken at the office or by mail are not attributed to a route.',
    ],
    filters: { ...filters, from: range.from, to: range.to },
    appliedTo: await describeFilters(ctx, filters, range),
    currency: ctx.organization.currency,
    timeZone,
    generatedAt: new Date().toISOString(),
  }
}
