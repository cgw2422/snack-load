import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, Download, History } from 'lucide-react'
import type { ImportType } from '@/generated/prisma/enums'
import { can, requireAuth } from '@/server/auth/context'
import { listImportJobs } from '@/server/services/import.service'
import { relativeTime } from '@/lib/dates'
import { Card, CardHeader } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { UploadForm } from './UploadForm'

/** Shared by the products and customers import entry points (spec §8, §10). */
export async function ImportLanding({
  type,
  noun,
  backHref,
  backLabel,
}: {
  type: ImportType
  noun: string
  backHref: string
  backLabel: string
}) {
  const ctx = await requireAuth()
  if (!can(ctx, type === 'PRODUCTS' ? 'product:import' : 'customer:import')) redirect(backHref)

  const history = (await listImportJobs(ctx)).filter((job) => job.type === type)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <Link
        href={backHref}
        className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-navy-600 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {backLabel}
      </Link>

      <div>
        <h1 className="text-xl font-extrabold text-ink">Import {noun}</h1>
        <p className="text-sm text-ink-muted">
          Bring your {noun} in from a spreadsheet. Re-importing later updates what is already here
          rather than creating duplicates.
        </p>
      </div>

      <Card className="p-4">
        <UploadForm type={type} />
      </Card>

      <a
        href={`/api/v1/imports/template?type=${type}`}
        className="inline-flex min-h-touch items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-navy-600 hover:bg-surface-sunken"
      >
        <Download className="size-4" aria-hidden="true" />
        Download a blank template
      </a>

      {history.length > 0 ? (
        <Card>
          <CardHeader title="Recent imports" />
          <ul className="divide-y divide-line">
            {history.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/imports/${job.id}`}
                  className="flex min-h-touch items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
                >
                  <History className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">
                      {job.fileName}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {relativeTime(new Date(job.createdAt))}
                      {job.createdByName ? ` · ${job.createdByName}` : ''}
                    </span>
                  </span>
                  {job.status === 'COMPLETED' ? (
                    <Pill tone="cash">{job.importedRows} imported</Pill>
                  ) : job.status === 'CANCELLED' ? (
                    <Pill>Cancelled</Pill>
                  ) : (
                    <Pill tone="alert">Unfinished</Pill>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}
