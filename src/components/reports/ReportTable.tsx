import { Card } from '@/components/ui/Card'
import type { ReportColumn, ReportResult, ReportRow } from '@/server/reports'

/**
 * A report on screen.
 *
 * Desktop gets the full table with every column, frozen header and a totals
 * row. A phone gets the same rows as cards showing the two or three columns
 * marked `primary`, with the rest as a definition list underneath — because a
 * ten-column table on a 390px screen is either a horizontal scroll nobody finds
 * or type nobody can read, and an owner checking yesterday's numbers from a
 * truck stop deserves better than both.
 */
export function ReportTable({ report }: { report: ReportResult }) {
  if (report.rows.length === 0) {
    return (
      <Card className="px-4 py-10 text-center">
        <p className="text-sm font-semibold text-ink">Nothing in this window</p>
        <p className="mt-1 text-sm text-ink-muted">
          Try a wider date range, or clear a filter.
        </p>
      </Card>
    )
  }

  const primary = report.columns.filter((c) => c.primary)
  const secondary = report.columns.filter((c) => !c.primary)

  return (
    <>
      {/* Desktop */}
      <Card className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              {report.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`px-3 py-2.5 align-bottom ${
                    column.format === 'text' ? 'text-left' : 'text-right'
                  }`}
                >
                  <span className="block text-xs font-bold uppercase tracking-wide text-ink-muted">
                    {column.label}
                  </span>
                  {column.hint ? (
                    <span className="block text-[11px] font-normal normal-case text-ink-subtle">
                      {column.hint}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, index) => (
              <tr key={index} className="border-b border-line last:border-0">
                {report.columns.map((column) => (
                  <td
                    key={column.key}
                    className={cellClass(column, row[column.key])}
                  >
                    {format(row[column.key], column, report)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {report.totals ? (
            <tfoot>
              <tr className="border-t-2 border-line-strong bg-surface-sunken">
                {report.columns.map((column) => (
                  <td
                    key={column.key}
                    className={`${cellClass(column, report.totals![column.key])} font-extrabold`}
                  >
                    {format(report.totals![column.key], column, report)}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </Card>

      {/* Phone */}
      <Card className="md:hidden">
        <ul className="divide-y divide-line">
          {report.rows.map((row, index) => (
            <li key={index} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                  {format(row[primary[0]?.key ?? report.columns[0].key], primary[0] ?? report.columns[0], report)}
                </span>
                {primary.slice(1).map((column) => (
                  <span
                    key={column.key}
                    className={`tnum shrink-0 text-sm font-bold ${valueTone(column, row[column.key])}`}
                  >
                    {format(row[column.key], column, report)}
                  </span>
                ))}
              </div>
              <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                {secondary.map((column) => (
                  <div key={column.key} className="flex items-baseline gap-1">
                    <dt className="text-[11px] text-ink-subtle">{column.label}</dt>
                    <dd className="tnum text-[11px] font-semibold text-ink-muted">
                      {format(row[column.key], column, report)}
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>

        {report.totals ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t-2 border-line-strong bg-surface-sunken px-4 py-3">
            <span className="text-sm font-extrabold text-ink">
              {format(report.totals[primary[0]?.key ?? 'label'], primary[0] ?? report.columns[0], report)}
            </span>
            {primary.slice(1).map((column) => (
              <span key={column.key} className="tnum text-sm font-extrabold text-ink">
                {format(report.totals![column.key], column, report)}
              </span>
            ))}
          </div>
        ) : null}
      </Card>
    </>
  )
}

function cellClass(column: ReportColumn, value: ReportRow[string]): string {
  return [
    'px-3 py-2',
    column.format === 'text' ? 'text-left text-ink' : 'tnum text-right',
    column.primary ? 'font-bold text-ink' : 'text-ink-muted',
    valueTone(column, value),
  ]
    .filter(Boolean)
    .join(' ')
}

/** Red for a loss or a decline; green for growth. Nothing else is coloured. */
function valueTone(column: ReportColumn, value: ReportRow[string]): string {
  if (value === null || value === undefined || value === '') return ''
  if (column.key === 'change' || column.key === 'grossProfit' || column.key === 'margin') {
    const n = Number(value)
    if (n < 0) return 'text-stop-600'
    if (column.key === 'change' && n >= 20) return 'text-cash-700'
  }
  return ''
}

function format(
  value: ReportRow[string] | undefined,
  column: ReportColumn,
  report: ReportResult,
): string {
  if (value === null || value === undefined || value === '') return '—'

  switch (column.format) {
    case 'money':
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: report.currency,
        minimumFractionDigits: 2,
      }).format(Number(value))
    case 'percent': {
      const n = Number(value)
      // A sign belongs on a change, not on a margin: "+24.5% margin" reads as
      // an improvement of 24.5 points rather than a margin of 24.5%.
      const sign = column.key === 'change' && n > 0 ? '+' : ''
      return `${sign}${n.toFixed(1)}%`
    }
    case 'number':
      return new Intl.NumberFormat('en-US').format(Number(value))
    case 'date':
      return new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeZone: report.timeZone,
      }).format(new Date(String(value)))
    default:
      return String(value)
  }
}
