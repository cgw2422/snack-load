'use client'

import { Download, FileSpreadsheet, FileText } from 'lucide-react'

/**
 * Export links (spec §34).
 *
 * Plain anchors, not fetch-and-blob: a download that the browser handles itself
 * survives a slow connection, shows real progress, and lands in the place the
 * person expects. The report's current filters ride along in the query string,
 * so what downloads is what is on screen.
 */
export function ExportButtons({ reportKey, search }: { reportKey: string; search: string }) {
  const base = `/api/v1/reports/${reportKey}/export?${search}`

  const formats = [
    { format: 'csv', label: 'CSV', icon: Download },
    { format: 'xlsx', label: 'Excel', icon: FileSpreadsheet },
    { format: 'pdf', label: 'PDF', icon: FileText },
  ] as const

  return (
    <div className="flex shrink-0 gap-2">
      {formats.map(({ format, label, icon: Icon }) => (
        <a
          key={format}
          href={`${base}&format=${format}`}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm font-semibold text-ink transition-colors hover:bg-surface-sunken"
        >
          <Icon className="size-4" aria-hidden="true" />
          {label}
        </a>
      ))}
    </div>
  )
}
