import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'navy' | 'flame' | 'cash' | 'alert' | 'stop'

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-ink-muted',
  navy: 'bg-navy-100 text-navy-700 dark:bg-navy-900/60 dark:text-navy-100',
  flame: 'bg-flame-100 text-flame-700 dark:bg-flame-700/25 dark:text-flame-200',
  cash: 'bg-cash-100 text-cash-700 dark:bg-cash-700/25 dark:text-cash-100',
  alert: 'bg-amber-100 text-alert-600 dark:bg-alert-600/25 dark:text-amber-100',
  stop: 'bg-stop-500/10 text-stop-600',
}

export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: Tone
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
