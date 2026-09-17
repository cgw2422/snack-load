import { AlertCircle, Check, Download, Link2, Mail, MessageSquare, Printer } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/Card'
import type { DeliveryRow } from '@/server/services/delivery.service'

const CHANNEL = {
  EMAIL: { icon: Mail, label: 'Emailed' },
  SMS: { icon: MessageSquare, label: 'Texted' },
  LINK: { icon: Link2, label: 'Link created' },
  PRINT: { icon: Printer, label: 'Printed' },
  DOWNLOAD: { icon: Download, label: 'Downloaded' },
} as const

/**
 * Where this receipt has been (spec §25).
 *
 * Every attempt, including the failures — a store insisting they never got the
 * invoice is a conversation this list ends, and a bounce that left no trace
 * would be worse than useless.
 */
export function DeliveryHistory({
  rows,
  timeZone,
}: {
  rows: DeliveryRow[]
  timeZone: string
}) {
  return (
    <Card className="print:hidden">
      <CardHeader title="Delivery history" />
      <ul className="divide-y divide-line">
        {rows.map((row) => {
          const channel = CHANNEL[row.channel] ?? CHANNEL.LINK
          const Icon = channel.icon
          const failed = row.status === 'FAILED'

          return (
            <li key={row.id} className="flex items-start gap-2.5 px-4 py-2.5">
              <Icon
                className={`mt-0.5 size-4 shrink-0 ${failed ? 'text-stop-600' : 'text-ink-subtle'}`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  {channel.label}
                  {row.destination ? (
                    <span className="font-normal text-ink-muted"> · {row.destination}</span>
                  ) : null}
                </p>
                <p className="text-xs text-ink-subtle">
                  {new Intl.DateTimeFormat('en-US', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone,
                  }).format(new Date(row.attemptedAt))}
                  {row.sentByName ? ` · ${row.sentByName}` : ''}
                  {row.provider ? ` · ${row.provider}` : ''}
                </p>
                {failed && row.failureReason ? (
                  <p className="mt-0.5 flex items-start gap-1 text-xs font-medium text-stop-600">
                    <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                    <span>{row.failureReason}</span>
                  </p>
                ) : null}
              </div>
              {failed ? (
                <span className="shrink-0 text-xs font-bold text-stop-600">Failed</span>
              ) : (
                <Check className="size-4 shrink-0 text-cash-600" aria-label="Sent" />
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
