import { Prisma } from '@/generated/prisma/client'
import type { AuthContext } from '@/server/auth/context'
import { m, toAmountString } from '@/server/domain/money'
import { describeFilters, resolveRange, reportQuery } from './filters'
import type { ReportColumn, ReportFilters, ReportResult, ReportRow } from './types'

/**
 * AR aging (spec §34).
 *
 * Buckets are measured from the **due date**, not the invoice date. An invoice
 * written on NET30 and sitting 20 days old is not late; one written COD and
 * sitting 20 days old is very late. Ageing from the invoice date would put both
 * in the same column and make the report useless for deciding who to call.
 *
 * The open balance is the invoice's own `balance_due`, so the report and the
 * receipt can never disagree. There is no separate AR ledger to drift away
 * (docs/02 §A1).
 */

type RawRow = {
  customer_id: string
  name: string
  account_number: string
  bucket_current: string | null
  bucket_1_30: string | null
  bucket_31_60: string | null
  bucket_61_90: string | null
  bucket_over_90: string | null
  total: string | null
  oldest_due: Date | null
  invoices: bigint
  credit: string | null
}

export async function runAgingReport(
  ctx: AuthContext,
  filters: ReportFilters,
): Promise<ReportResult> {
  const timeZone = ctx.organization.timezone
  // Aging is always as of now; the range only labels the export.
  const range = resolveRange(filters, timeZone)
  const asOf = new Date()

  const customerFilter = filters.customerId
    ? Prisma.sql`AND c.id = ${filters.customerId}`
    : Prisma.empty
  const routeFilter = filters.routeTemplateId
    ? Prisma.sql`
        AND c.id IN (
          SELECT cs.customer_id FROM customer_schedule cs
           WHERE cs.route_template_id = ${filters.routeTemplateId} AND cs.active = true
        )`
    : Prisma.empty

  const raw = await reportQuery<RawRow>(
    ctx,
    Prisma.sql`
      WITH open_invoices AS (
        SELECT s.customer_id,
               s.balance_due,
               -- COD has no due date; it was due when it was written.
               COALESCE(s.due_date, s.occurred_at::date) AS due_on,
               (${asOf}::date - COALESCE(s.due_date, s.occurred_at::date)) AS days_late
          FROM sale s
         WHERE s.organization_id = ${ctx.organizationId}
           AND s.status = 'COMPLETED'
           AND s.balance_due > 0
      ),
      credits AS (
        SELECT p.customer_id, SUM(p.unapplied_amount) AS credit
          FROM payment p
         WHERE p.organization_id = ${ctx.organizationId}
           AND p.status = 'POSTED'
           AND p.unapplied_amount > 0
         GROUP BY p.customer_id
      )
      SELECT c.id AS customer_id,
             c.name,
             c.account_number,
             COALESCE(SUM(o.balance_due) FILTER (WHERE o.days_late <= 0), 0)::text AS bucket_current,
             COALESCE(SUM(o.balance_due) FILTER (WHERE o.days_late BETWEEN 1 AND 30), 0)::text AS bucket_1_30,
             COALESCE(SUM(o.balance_due) FILTER (WHERE o.days_late BETWEEN 31 AND 60), 0)::text AS bucket_31_60,
             COALESCE(SUM(o.balance_due) FILTER (WHERE o.days_late BETWEEN 61 AND 90), 0)::text AS bucket_61_90,
             COALESCE(SUM(o.balance_due) FILTER (WHERE o.days_late > 90), 0)::text AS bucket_over_90,
             COALESCE(SUM(o.balance_due), 0)::text AS total,
             MIN(o.due_on) AS oldest_due,
             COUNT(o.balance_due)::bigint AS invoices,
             COALESCE(MAX(cr.credit), 0)::text AS credit
        FROM customer c
        JOIN open_invoices o ON o.customer_id = c.id
        LEFT JOIN credits cr ON cr.customer_id = c.id
       WHERE c.organization_id = ${ctx.organizationId}
         ${customerFilter}
         ${routeFilter}
       GROUP BY c.id, c.name, c.account_number
       -- On the numeric sum, not on the ordinal of a ::text column: the money
       -- columns are cast to text so they never pass through a float, and
       -- ordering by one of those would sort "772.68" above "2824.05".
       ORDER BY SUM(o.balance_due) DESC
    `,
  )

  const rows: ReportRow[] = raw.map((row) => ({
    label: row.name,
    accountNumber: row.account_number,
    invoices: Number(row.invoices),
    current: toAmountString(row.bucket_current ?? '0'),
    d1to30: toAmountString(row.bucket_1_30 ?? '0'),
    d31to60: toAmountString(row.bucket_31_60 ?? '0'),
    d61to90: toAmountString(row.bucket_61_90 ?? '0'),
    over90: toAmountString(row.bucket_over_90 ?? '0'),
    total: toAmountString(row.total ?? '0'),
    credit: toAmountString(row.credit ?? '0'),
    oldestDue: row.oldest_due ? row.oldest_due.toISOString() : null,
  }))

  const sumOf = (key: string) =>
    toAmountString(rows.reduce((total, r) => total.plus(m(String(r[key]))), m(0)))

  const totals: ReportRow = {
    label: 'All stores',
    accountNumber: '',
    invoices: rows.reduce((n, r) => n + Number(r.invoices), 0),
    current: sumOf('current'),
    d1to30: sumOf('d1to30'),
    d31to60: sumOf('d31to60'),
    d61to90: sumOf('d61to90'),
    over90: sumOf('over90'),
    total: sumOf('total'),
    credit: sumOf('credit'),
    oldestDue: null,
  }

  const columns: ReportColumn[] = [
    { key: 'label', label: 'Store', format: 'text', primary: true },
    { key: 'invoices', label: 'Invoices', format: 'number' },
    { key: 'current', label: 'Current', format: 'money', hint: 'Not yet due' },
    { key: 'd1to30', label: '1–30', format: 'money' },
    { key: 'd31to60', label: '31–60', format: 'money' },
    { key: 'd61to90', label: '61–90', format: 'money' },
    { key: 'over90', label: '90+', format: 'money', primary: true },
    { key: 'total', label: 'Total owed', format: 'money', primary: true },
    { key: 'credit', label: 'Credit held', format: 'money', hint: 'Unapplied payments' },
    { key: 'oldestDue', label: 'Oldest due', format: 'date' },
  ]

  return {
    key: 'aging',
    title: 'Receivables aging',
    definition:
      'Open balances as of today, bucketed by days past the invoice DUE DATE — ' +
      'not the invoice date — so terms are respected: a NET30 invoice written ' +
      '20 days ago is Current, while a COD invoice written 20 days ago is 1–30 ' +
      'days late. Each figure is the invoice\'s own remaining balance, so this ' +
      'report and the receipt can never disagree. Credit held is unapplied ' +
      'payment money sitting on the account; it is shown separately rather than ' +
      'netted off, because it has not been applied to any of these invoices.',
    columns,
    rows,
    totals,
    notes: [
      'Aging is as of today. The date range above labels the export; it does not move the buckets.',
      'Voided sales carry no balance and never appear here.',
      'Credit held is not subtracted from the total owed — it is money waiting to be applied.',
    ],
    filters: { ...filters, from: range.from, to: range.to },
    appliedTo: await describeFilters(ctx, filters, range),
    currency: ctx.organization.currency,
    timeZone,
    generatedAt: new Date().toISOString(),
  }
}
