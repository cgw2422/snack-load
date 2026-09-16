import { cn } from '@/lib/cn'
import { formatMoney } from '@/server/domain/money'
import type { MetricTile as Metric } from '@/server/services/dashboard.service'

const TONES: Record<Metric['tone'], string> = {
  navy: 'bg-navy-50 text-navy-800 dark:bg-navy-900/60 dark:text-navy-100',
  flame: 'bg-flame-50 text-flame-700 dark:bg-flame-700/20 dark:text-flame-200',
  cash: 'bg-cash-50 text-cash-700 dark:bg-cash-700/20 dark:text-cash-100',
  alert: 'bg-amber-50 text-alert-600 dark:bg-alert-600/20 dark:text-amber-100',
}

/** Money tiles are formatted here; the service hands over exact decimal strings. */
const MONEY_KEYS = new Set(['sales-today', 'receivables', 'inventory-value'])

export function MetricTileCard({
  metric,
  currency,
  className,
}: {
  metric: Metric
  currency: string
  className?: string
}) {
  const display = MONEY_KEYS.has(metric.key) ? formatMoney(metric.value, currency) : metric.value

  return (
    <div className={cn('rounded-card px-3.5 py-3', TONES[metric.tone], className)}>
      <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">{metric.label}</p>
      <p className="tnum mt-1 text-xl font-extrabold leading-tight sm:text-2xl">{display}</p>
      {metric.detail ? (
        <p className="mt-0.5 text-[11px] font-medium opacity-70">{metric.detail}</p>
      ) : null}
    </div>
  )
}
