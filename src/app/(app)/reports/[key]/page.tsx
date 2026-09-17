import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { ChevronLeft, Info } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { REPORTS, isReportKey, runReport } from '@/server/reports'
import { flattenSearchParams, firstValue } from '@/lib/searchParams'
import { isAppError } from '@/lib/errors'
import { Card } from '@/components/ui/Card'
import { ReportControls, type Option } from '@/components/reports/ReportControls'
import { ReportTable } from '@/components/reports/ReportTable'
import { ExportButtons } from '@/components/reports/ExportButtons'

export const metadata: Metadata = { title: 'Report' }

export default async function ReportPage(props: PageProps<'/reports/[key]'>) {
  const { key } = await props.params
  const ctx = await requireAuth()
  if (!can(ctx, 'report:read')) redirect('/')
  if (!isReportKey(key)) notFound()

  const definition = REPORTS[key]
  const raw = flattenSearchParams(await props.searchParams)

  const report = await runReport(ctx, key, {
    from: firstValue(raw.from) ?? '',
    to: firstValue(raw.to) ?? '',
    routeTemplateId: firstValue(raw.routeTemplateId),
    runnerUserId: firstValue(raw.runnerUserId),
    customerId: firstValue(raw.customerId),
    productId: firstValue(raw.productId),
    categoryId: firstValue(raw.categoryId),
    groupBy: firstValue(raw.groupBy),
  }).catch((error: unknown) => {
    // A report the viewer may not open is not a report that exists, as far as
    // they are concerned.
    if (isAppError(error) && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')) notFound()
    throw error
  })

  const [routes, runners, customers, categories] = await Promise.all([
    definition.supports.route ? routeOptions(ctx) : undefined,
    definition.supports.runner ? runnerOptions(ctx) : undefined,
    definition.supports.customer ? customerOptions(ctx) : undefined,
    definition.supports.category ? categoryOptions(ctx) : undefined,
  ])

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6">
      <Link
        href="/reports"
        className="inline-flex min-h-touch items-center gap-1 text-sm font-semibold text-ink-muted hover:text-ink"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        Reports
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold text-ink">{report.title}</h1>
          <p className="text-sm text-ink-muted">{report.appliedTo}</p>
        </div>
        {can(ctx, 'report:export') ? (
          <ExportButtons reportKey={key} search={toQueryString(report.filters)} />
        ) : null}
      </div>

      <ReportControls
        from={report.filters.from}
        to={report.filters.to}
        timeZone={report.timeZone}
        groupings={definition.supports.groupBy?.map((g) => ({ value: g.key, label: g.label }))}
        routes={routes}
        runners={runners}
        customers={customers}
        categories={categories}
      />

      <ReportTable report={report} />

      <Card className="space-y-2 p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-bold text-ink">
          <Info className="size-4 text-navy-600" aria-hidden="true" />
          What this measures
        </h2>
        <p className="text-sm leading-relaxed text-ink-muted">{report.definition}</p>
        {report.notes.length > 0 ? (
          <ul className="space-y-1 pt-1">
            {report.notes.map((note) => (
              <li key={note} className="flex gap-1.5 text-xs text-ink-subtle">
                <span aria-hidden="true">•</span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  )
}

function toQueryString(filters: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value)
  }
  return query.toString()
}

async function routeOptions(ctx: Awaited<ReturnType<typeof requireAuth>>): Promise<Option[]> {
  const rows = await db(ctx).routeTemplate.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
  return rows.map((r) => ({ value: r.id, label: r.name }))
}

async function runnerOptions(ctx: Awaited<ReturnType<typeof requireAuth>>): Promise<Option[]> {
  const rows = await db(ctx).membership.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { user: { firstName: 'asc' } },
    select: { userId: true, user: { select: { firstName: true, lastName: true } } },
  })
  return rows.map((r) => ({
    value: r.userId,
    label: `${r.user.firstName} ${r.user.lastName}`.trim(),
  }))
}

async function customerOptions(ctx: Awaited<ReturnType<typeof requireAuth>>): Promise<Option[]> {
  const rows = await db(ctx).customer.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    take: 500,
    select: { id: true, name: true },
  })
  return rows.map((c) => ({ value: c.id, label: c.name }))
}

async function categoryOptions(ctx: Awaited<ReturnType<typeof requireAuth>>): Promise<Option[]> {
  const rows = await db(ctx).productCategory.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
  return rows.map((c) => ({ value: c.id, label: c.name }))
}
