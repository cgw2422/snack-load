import Link from 'next/link'
import { Check, ChevronRight, CircleSlash, Clock, DoorClosed, SkipForward } from 'lucide-react'
import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import { formatMoney } from '@/server/domain/money'
import { formatTime } from '@/lib/dates'
import { Pill } from '@/components/ui/Pill'
import type { RouteStopDetail } from '@/server/services/route.service'

const OUTCOME: Record<string, { label: string; icon: ComponentType<LucideProps>; tone: 'cash' | 'alert' | 'neutral' }> = {
  COMPLETED: { label: 'Sold', icon: Check, tone: 'cash' },
  NO_SALE: { label: 'No sale', icon: CircleSlash, tone: 'neutral' },
  STORE_CLOSED: { label: 'Closed', icon: DoorClosed, tone: 'alert' },
  SKIPPED: { label: 'Skipped', icon: SkipForward, tone: 'neutral' },
  RESCHEDULED: { label: 'Rescheduled', icon: Clock, tone: 'alert' },
  ARRIVED: { label: 'Here now', icon: Clock, tone: 'alert' },
}

export function StopList({
  routeId,
  stops,
  currency,
  timezone,
  interactive = true,
}: {
  routeId: string
  stops: RouteStopDetail[]
  currency: string
  timezone: string
  interactive?: boolean
}) {
  return (
    <ul className="divide-y divide-line">
      {stops.map((stop) => {
        const outcome = OUTCOME[stop.status]
        const done = stop.status !== 'PENDING' && stop.status !== 'ARRIVED'
        const Icon = outcome?.icon

        const body = (
          <>
            <span
              className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                done
                  ? 'bg-cash-500 text-white'
                  : stop.status === 'ARRIVED'
                    ? 'bg-flame-500 text-white'
                    : 'bg-navy-100 text-navy-800 dark:bg-navy-900 dark:text-navy-100'
              }`}
            >
              {done && Icon ? <Icon className="size-4" aria-hidden="true" /> : stop.sequence}
            </span>

            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-ink">
                  {stop.customerName}
                </span>
                {outcome ? <Pill tone={outcome.tone}>{outcome.label}</Pill> : null}
              </span>
              <span className="block truncate text-xs text-ink-muted">{stop.addressLine}</span>
              {stop.outcomeReason ? (
                <span className="block truncate text-xs text-ink-subtle">
                  {stop.outcomeReason}
                </span>
              ) : null}
            </span>

            <span className="shrink-0 text-right">
              {stop.saleTotal ? (
                <span className="tnum block text-sm font-bold text-cash-600">
                  {formatMoney(stop.saleTotal, currency)}
                </span>
              ) : Number(stop.balance) > 0 ? (
                <span className="tnum block text-sm font-semibold text-alert-600">
                  {formatMoney(stop.balance, currency)}
                </span>
              ) : null}
              {stop.completedAt ? (
                <span className="block text-xs text-ink-subtle">
                  {formatTime(new Date(stop.completedAt), timezone)}
                </span>
              ) : null}
            </span>
          </>
        )

        if (!interactive) {
          return (
            <li key={stop.id} className="flex min-h-touch items-center gap-3 px-4 py-3">
              {body}
            </li>
          )
        }

        return (
          <li key={stop.id}>
            <Link
              href={`/routes/${routeId}/stops/${stop.id}`}
              className="flex min-h-touch items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
            >
              {body}
              <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
