import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { BarChart3, ChevronRight } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { visibleReports } from '@/server/reports'
import { Card } from '@/components/ui/Card'

export const metadata: Metadata = { title: 'Reports' }

/**
 * The reports centre (spec §29).
 *
 * A short list rather than a dashboard of charts. An owner comes here with a
 * question already in mind — what sold, what it earned, who owes me — and the
 * fastest thing the page can do is get out of the way.
 */
export default async function ReportsPage() {
  const ctx = await requireAuth()
  if (!can(ctx, 'report:read')) redirect('/')

  const reports = visibleReports(ctx)

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6">
      <div>
        <h1 className="text-xl font-extrabold text-ink">Reports</h1>
        <p className="text-sm text-ink-muted">
          Built from posted transactions — no separate set of books to drift.
        </p>
      </div>

      <Card>
        <ul className="divide-y divide-line">
          {reports.map((report) => (
            <li key={report.key}>
              <Link
                href={`/reports/${report.key}`}
                className="flex min-h-touch items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-sunken"
              >
                <BarChart3 className="size-5 shrink-0 text-navy-600" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{report.title}</span>
                  <span className="block text-xs text-ink-muted">{report.summary}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      {!can(ctx, 'report:financial') ? (
        <p className="px-1 text-xs text-ink-subtle">
          Cost, margin and receivables reports need the financial reporting permission.
        </p>
      ) : null}
    </div>
  )
}
