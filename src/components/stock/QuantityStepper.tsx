'use client'

import { Minus, Plus } from 'lucide-react'

/**
 * −/+ with a typed value between them. Steppers rather than a keyboard, because
 * the person using this is usually holding something in the other hand
 * (docs/05 §1). 44px targets, numeric keypad, select-on-focus.
 */
export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 1_000_000,
  label,
}: {
  value: number
  onChange: (next: number) => void
  min?: number
  max?: number
  label: string
}) {
  const clamp = (next: number) => Math.max(min, Math.min(max, next))

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label={`Fewer ${label}`}
        onClick={() => onChange(clamp(value - 1))}
        disabled={value <= min}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface-raised text-ink transition-colors active:bg-surface-sunken disabled:opacity-40"
      >
        <Minus className="size-4" aria-hidden="true" />
      </button>

      <input
        type="text"
        inputMode="numeric"
        pattern="-?[0-9]*"
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const parsed = Number(e.target.value.replace(/[^\d-]/g, ''))
          onChange(Number.isFinite(parsed) ? clamp(parsed) : min)
        }}
        className="tnum h-11 w-16 rounded-lg border border-line-strong bg-surface-raised text-center text-base font-bold text-ink focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/20"
      />

      <button
        type="button"
        aria-label={`More ${label}`}
        onClick={() => onChange(clamp(value + 1))}
        disabled={value >= max}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface-raised text-ink transition-colors active:bg-surface-sunken disabled:opacity-40"
      >
        <Plus className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}
