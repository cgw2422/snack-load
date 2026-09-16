'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, FileSpreadsheet, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { uploadImportAction, type UploadState } from '@/app/(app)/imports/actions'

const EMPTY: UploadState = {}

function Submit({ hasFile }: { hasFile: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" size="lg" block disabled={pending || !hasFile}>
      {pending ? 'Reading your file…' : 'Continue'}
    </Button>
  )
}

export function UploadForm({ type }: { type: 'PRODUCTS' | 'CUSTOMERS' }) {
  const [state, action] = useActionState(uploadImportAction, EMPTY)
  const [fileName, setFileName] = useState<string | null>(null)

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="type" value={type} />

      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      ) : null}

      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-line-strong bg-surface-sunken px-6 py-10 text-center transition-colors hover:border-navy-500 hover:bg-navy-50/40">
        {fileName ? (
          <>
            <FileSpreadsheet className="size-8 text-cash-600" aria-hidden="true" />
            <span className="text-sm font-semibold text-ink">{fileName}</span>
            <span className="text-xs text-ink-muted">Choose a different file</span>
          </>
        ) : (
          <>
            <Upload className="size-8 text-ink-subtle" aria-hidden="true" />
            <span className="text-sm font-semibold text-ink">Choose a file</span>
            <span className="text-xs text-ink-muted">CSV or Excel, up to 15 MB</span>
          </>
        )}
        <input
          type="file"
          name="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          className="sr-only"
          onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)}
        />
      </label>

      <Submit hasFile={fileName !== null} />

      <p className="text-center text-xs text-ink-muted">
        Your column names don&apos;t have to match ours — you&apos;ll map them on the next screen.
      </p>
    </form>
  )
}
