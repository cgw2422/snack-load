'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Check, CircleAlert, Download, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { commitImportAction, patchImportRowAction, type MappingState } from '@/app/(app)/imports/actions'
import type { ImportPreview } from '@/server/services/import.service'

const EMPTY: MappingState = {}

function Commit({ count }: { count: number }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="cash" size="lg" disabled={pending || count === 0}>
      {pending ? 'Importing…' : `Import ${count.toLocaleString()} rows`}
    </Button>
  )
}

const STATUS_TONE = { READY: 'cash', WARNING: 'alert', ERROR: 'stop', IMPORTED: 'cash', SKIPPED: 'neutral' } as const

export function PreviewTable({ preview }: { preview: ImportPreview }) {
  const [state, action] = useActionState(commitImportAction, EMPTY)
  const [skipWarnings, setSkipWarnings] = useState(false)

  const importable = skipWarnings
    ? preview.readyRows
    : preview.readyRows + preview.warningRows
  const done = preview.status === 'COMPLETED'

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile label="Rows found" value={preview.totalRows} tone="navy" />
        <Tile label="Ready" value={preview.readyRows} tone="cash" />
        <Tile label="Warnings" value={preview.warningRows} tone="alert" />
        <Tile label="Errors" value={preview.errorRows} tone="stop" />
      </div>

      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      ) : null}

      {state.message || done ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-cash-500/30 bg-cash-50 px-3.5 py-3 text-sm text-cash-700 dark:bg-cash-700/15 dark:text-cash-100"
        >
          <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {state.message ??
              `Imported ${preview.importedRows} of ${preview.totalRows} rows.`}
          </span>
        </div>
      ) : null}

      {!done ? (
        <form action={action} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="jobId" value={preview.id} />
          <Commit count={importable} />

          {preview.warningRows > 0 ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="skipWarnings"
                checked={skipWarnings}
                onChange={(e) => setSkipWarnings(e.target.checked)}
                className="size-4 rounded border-line-strong text-navy-700 focus:ring-navy-500/30"
              />
              Skip the {preview.warningRows} rows with warnings
            </label>
          ) : null}

          {preview.errorRows + preview.warningRows > 0 ? (
            <a
              href={`/api/v1/imports/${preview.id}/errors.csv`}
              className="inline-flex min-h-touch items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-navy-600 hover:bg-surface-sunken"
            >
              <Download className="size-4" aria-hidden="true" />
              Download problem rows
            </a>
          ) : null}
        </form>
      ) : null}

      <div className="overflow-hidden rounded-card border border-line bg-surface-raised">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold text-ink">
            {done ? 'What happened' : 'Preview'}
          </h2>
          <p className="text-xs text-ink-muted">
            {done
              ? 'Every row and its outcome. This record stays with the import.'
              : 'Problem rows first. Fix a cell here and we’ll recheck just that row.'}
          </p>
        </div>

        <ul className="divide-y divide-line">
          {preview.rows.map((row) => (
            <li key={row.id} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <span className="tnum w-10 shrink-0 pt-0.5 text-xs font-semibold text-ink-subtle">
                  {row.rowNumber}
                </span>

                <div className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-ink">
                      {String(row.values.name ?? row.values.sku ?? row.values.accountNumber ?? '—')}
                    </span>
                    <Pill tone={STATUS_TONE[row.status as keyof typeof STATUS_TONE] ?? 'neutral'}>
                      {row.status === 'IMPORTED'
                        ? 'Imported'
                        : row.action === 'UPDATE'
                          ? 'Update'
                          : row.action === 'SKIP'
                            ? 'Skipped'
                            : 'New'}
                    </Pill>
                  </span>

                  {row.messages.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {row.messages.map((message, i) => (
                        <li
                          key={i}
                          className={`flex items-start gap-1.5 text-xs ${
                            message.level === 'error' ? 'text-stop-600' : 'text-alert-600'
                          }`}
                        >
                          {message.level === 'error' ? (
                            <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                          ) : (
                            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                          )}
                          {message.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {!done && row.status === 'ERROR' ? (
                    <InlineFix jobId={preview.id} rowId={row.id} row={row} preview={preview} />
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>

        {preview.totalRows > preview.rows.length ? (
          <p className="border-t border-line px-4 py-2.5 text-xs text-ink-subtle">
            Showing {preview.rows.length} of {preview.totalRows.toLocaleString()} rows.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** Fix a cell without re-uploading the file — only that row is re-checked. */
function InlineFix({
  jobId,
  rowId,
  row,
  preview,
}: {
  jobId: string
  rowId: string
  row: ImportPreview['rows'][number]
  preview: ImportPreview
}) {
  const firstFieldError = row.messages.find((mm) => mm.level === 'error' && mm.field)
  if (!firstFieldError?.field) return null

  const column = preview.mapping[firstFieldError.field]
  if (!column) return null

  const field = preview.fields.find((f) => f.key === firstFieldError.field)

  return (
    <form action={patchImportRowAction} className="mt-2 flex items-center gap-2">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="rowId" value={rowId} />
      <input type="hidden" name="column" value={column} />
      <input
        name="value"
        defaultValue={row.raw[column] ?? ''}
        placeholder={field?.label ?? column}
        aria-label={`Fix ${field?.label ?? column} on row ${row.rowNumber}`}
        className="h-10 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2.5 text-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/20"
      />
      <Button type="submit" size="sm" variant="secondary">
        Fix
      </Button>
    </form>
  )
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'navy' | 'cash' | 'alert' | 'stop'
}) {
  const tones = {
    navy: 'bg-navy-50 text-navy-800 dark:bg-navy-900/60 dark:text-navy-100',
    cash: 'bg-cash-50 text-cash-700 dark:bg-cash-700/20 dark:text-cash-100',
    alert: 'bg-amber-50 text-alert-600 dark:bg-alert-600/20 dark:text-amber-100',
    stop: 'bg-stop-500/10 text-stop-600',
  }
  return (
    <div className={`rounded-card px-3.5 py-3 ${tones[tone]}`}>
      <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">{label}</p>
      <p className="tnum mt-0.5 text-2xl font-extrabold">{value.toLocaleString()}</p>
    </div>
  )
}
