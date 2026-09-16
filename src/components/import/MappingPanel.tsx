'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Check, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import { Pill } from '@/components/ui/Pill'
import { validateImportAction, type MappingState } from '@/app/(app)/imports/actions'
import type { ImportPreview } from '@/server/services/import.service'

const EMPTY: MappingState = {}

function Recheck() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="primary" size="md" disabled={pending}>
      <RefreshCw className={pending ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
      {pending ? 'Checking…' : 'Check rows'}
    </Button>
  )
}

/**
 * Column mapping and reference resolution in one form (docs/03 §5).
 *
 * Both steps re-run validation, so an owner can adjust a mapping, resolve
 * "Tuesday" to a real route, and see the counts change without re-uploading.
 */
export function MappingPanel({ preview }: { preview: ImportPreview }) {
  const [state, action] = useActionState(validateImportAction, EMPTY)

  const matchKeyOptions =
    preview.type === 'PRODUCTS'
      ? [
          { value: 'SKU', label: 'SKU' },
          { value: 'UPC', label: 'UPC / barcode' },
        ]
      : [
          { value: 'ACCOUNT_NUMBER', label: 'Account number' },
          { value: 'NAME', label: 'Store name' },
        ]

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="jobId" value={preview.id} />

      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      ) : null}

      <div className="rounded-card border border-line bg-surface-raised">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold text-ink">How should we read your file?</h2>
          <p className="text-xs text-ink-muted">
            Match existing records on a key so a re-import updates them instead of creating
            duplicates.
          </p>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <label className="space-y-1.5">
            <span className="block text-sm font-medium text-ink">When a record already exists</span>
            <Select name="mode" defaultValue={preview.mode}>
              <option value="UPSERT">Update it, and add anything new</option>
              <option value="CREATE_ONLY">Only add new records</option>
              <option value="UPDATE_ONLY">Only update existing records</option>
            </Select>
          </label>

          <label className="space-y-1.5">
            <span className="block text-sm font-medium text-ink">Match records on</span>
            <Select name="matchKey" defaultValue={preview.matchKey}>
              {matchKeyOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>

      <div className="rounded-card border border-line bg-surface-raised">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold text-ink">Match up your columns</h2>
          <p className="text-xs text-ink-muted">
            We&apos;ve guessed from your headings. Change anything we got wrong, and leave out
            anything you don&apos;t want imported.
          </p>
        </div>

        <ul className="divide-y divide-line">
          {preview.fields.map((field) => {
            const current = preview.mapping[field.key] ?? ''
            return (
              <li key={field.key} className="grid gap-2 px-4 py-3 sm:grid-cols-2 sm:items-center">
                <div className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-ink">{field.label}</span>
                    {field.required ? <Pill tone="flame">Required</Pill> : null}
                    {field.matchKey ? <Pill tone="navy">Match key</Pill> : null}
                  </span>
                  {field.help ? (
                    <span className="block text-xs text-ink-muted">{field.help}</span>
                  ) : null}
                </div>

                <Select name={`map:${field.key}`} defaultValue={current} aria-label={field.label}>
                  <option value="">Don&apos;t import</option>
                  {preview.headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </Select>
              </li>
            )
          })}
        </ul>
      </div>

      {preview.unresolved.length > 0 ? (
        <div className="rounded-card border border-alert-500/40 bg-amber-50 dark:bg-alert-600/10">
          <div className="border-b border-alert-500/30 px-4 py-3">
            <h2 className="text-[15px] font-semibold text-alert-600">
              These need a decision from you
            </h2>
            <p className="text-xs text-alert-600/80">
              Your file names routes and people we don&apos;t recognise. Nothing is created from a
              spreadsheet cell — tell us what each one means.
            </p>
          </div>

          <ul className="divide-y divide-alert-500/20">
            {preview.unresolved.map((item) => (
              <li
                key={`${item.kind}:${item.value}`}
                className="grid gap-2 px-4 py-3 sm:grid-cols-2 sm:items-center"
              >
                <div className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">
                    &ldquo;{item.value}&rdquo;
                  </span>
                  <span className="block text-xs text-ink-muted">
                    named as a {item.kind} in your file
                  </span>
                </div>

                <Select
                  name={`ref:${item.kind}:${item.value.toLowerCase()}`}
                  defaultValue=""
                  aria-label={`What is ${item.value}?`}
                >
                  <option value="">Leave unassigned</option>
                  {item.suggestions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Recheck />
        {state.message ? (
          <span className="flex items-center gap-1.5 text-sm font-medium text-cash-600">
            <Check className="size-4" aria-hidden="true" />
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  )
}
