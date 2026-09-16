import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound as nextNotFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/server/auth/context'
import { getImportPreview } from '@/server/services/import.service'
import { isAppError } from '@/lib/errors'
import { MappingPanel } from '@/components/import/MappingPanel'
import { PreviewTable } from '@/components/import/PreviewTable'
import { cancelImportAction } from '../actions'

export const metadata: Metadata = { title: 'Import' }

export default async function ImportPage(props: PageProps<'/imports/[id]'>) {
  const ctx = await requireAuth()
  const { id } = await props.params

  let preview
  try {
    preview = await getImportPreview(ctx, id)
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') nextNotFound()
    throw error
  }

  const returnTo = preview.type === 'PRODUCTS' ? '/inventory/products' : '/customers'
  const noun = preview.type === 'PRODUCTS' ? 'products' : 'stores'
  const validated = preview.status !== 'MAPPING' && preview.status !== 'UPLOADED'

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <Link
        href={returnTo}
        className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-navy-600 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to {noun}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold text-ink">
            Import {noun}
          </h1>
          <p className="truncate text-sm text-ink-muted">
            {preview.fileName} · {preview.totalRows.toLocaleString()} rows
            {preview.createdByName ? ` · uploaded by ${preview.createdByName}` : ''}
          </p>
        </div>

        {preview.status !== 'COMPLETED' ? (
          <form action={cancelImportAction}>
            <input type="hidden" name="jobId" value={preview.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <button
              type="submit"
              className="min-h-touch rounded-lg px-3 text-sm font-semibold text-stop-600 transition-colors hover:bg-stop-500/5"
            >
              Cancel import
            </button>
          </form>
        ) : null}
      </div>

      {preview.status !== 'COMPLETED' ? <MappingPanel preview={preview} /> : null}

      {validated ? <PreviewTable preview={preview} /> : null}
    </div>
  )
}
