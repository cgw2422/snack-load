'use client'

import { useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { CalendarRange, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Select } from '@/components/ui/Field'
import { Pill } from '@/components/ui/Pill'

export type Option = { value: string; label: string }

/**
 * Report filters (spec §29).
 *
 * The presets carry the weight. Almost every question somebody actually asks is
 * "this week", "last month", or "this year so far", and making them type two
 * dates to get there is the difference between a report they open daily and one
 * they open never. The exact range stays available underneath.
 *
 * All of it lives in the URL, so a filtered report is a link that can be sent to
 * the office, bookmarked, or handed to the export button unchanged.
 */
export function ReportControls({
  from,
  to,
  timeZone,
  groupings,
  routes,
  runners,
  customers,
  categories,
}: {
  from: string
  to: string
  timeZone: string
  groupings?: Option[]
  routes?: Option[]
  runners?: Option[]
  customers?: Option[]
  categories?: Option[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [open, setOpen] = useState(false)

  const presets = buildPresets(timeZone)
  const activePreset = presets.find((p) => p.from === from && p.to === to)

  function set(changes: Record<string, string | undefined>) {
    const query = new URLSearchParams(params.toString())
    for (const [key, value] of Object.entries(changes)) {
      if (value) query.set(key, value)
      else query.delete(key)
    }
    router.replace(`${pathname}?${query}`, { scroll: false })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => set({ from: preset.from, to: preset.to })}
            aria-pressed={activePreset?.label === preset.label}
            className={`h-9 rounded-lg border px-3 text-sm font-semibold transition-colors ${
              activePreset?.label === preset.label
                ? 'border-navy-800 bg-navy-800 text-white'
                : 'border-line-strong bg-surface-raised text-ink-muted hover:bg-surface-sunken'
            }`}
          >
            {preset.label}
          </button>
        ))}

        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(!open)}>
          <SlidersHorizontal className="size-4" aria-hidden="true" />
          More
        </Button>

        {!activePreset ? (
          <Pill tone="navy">
            <CalendarRange className="mr-1 inline size-3" aria-hidden="true" />
            {from} → {to}
          </Pill>
        ) : null}
      </div>

      {groupings && groupings.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Group by
          </span>
          {groupings.map((option) => {
            const current = params.get('groupBy') ?? groupings[0].value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => set({ groupBy: option.value })}
                aria-pressed={current === option.value}
                className={`h-8 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                  current === option.value
                    ? 'bg-flame-500 text-white'
                    : 'bg-surface-sunken text-ink-muted hover:text-ink'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      ) : null}

      {open ? (
        <Card className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From" htmlFor="report-from">
              <input
                id="report-from"
                type="date"
                defaultValue={from}
                onChange={(e) => set({ from: e.target.value })}
                className="h-12 w-full rounded-xl border border-line-strong bg-surface-raised px-3.5 text-ink focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/20"
              />
            </Field>
            <Field label="To" htmlFor="report-to">
              <input
                id="report-to"
                type="date"
                defaultValue={to}
                onChange={(e) => set({ to: e.target.value })}
                className="h-12 w-full rounded-xl border border-line-strong bg-surface-raised px-3.5 text-ink focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/20"
              />
            </Field>
          </div>

          <Picker label="Route" param="routeTemplateId" options={routes} params={params} set={set} />
          <Picker label="Runner" param="runnerUserId" options={runners} params={params} set={set} />
          <Picker label="Store" param="customerId" options={customers} params={params} set={set} />
          <Picker label="Category" param="categoryId" options={categories} params={params} set={set} />
        </Card>
      ) : null}
    </div>
  )
}

function Picker({
  label,
  param,
  options,
  params,
  set,
}: {
  label: string
  param: string
  options?: Option[]
  params: URLSearchParams
  set: (changes: Record<string, string | undefined>) => void
}) {
  if (!options || options.length === 0) return null

  return (
    <Field label={label} htmlFor={`report-${param}`}>
      <Select
        id={`report-${param}`}
        value={params.get(param) ?? ''}
        onChange={(e) => set({ [param]: e.target.value || undefined })}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/**
 * Presets are computed in the organization's timezone, so "today" is the
 * distributor's today and not the server's.
 */
function buildPresets(timeZone: string): { label: string; from: string; to: string }[] {
  const day = (offsetDays: number) => {
    const date = new Date(Date.now() - offsetDays * 86_400_000)
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date)
  }

  const today = day(0)
  const startOfMonth = `${today.slice(0, 7)}-01`

  const lastMonthEnd = new Date(`${startOfMonth}T12:00:00Z`)
  lastMonthEnd.setUTCDate(0)
  const lastMonthEndStr = lastMonthEnd.toISOString().slice(0, 10)
  const lastMonthStart = `${lastMonthEndStr.slice(0, 7)}-01`

  return [
    { label: 'Today', from: today, to: today },
    { label: '7 days', from: day(6), to: today },
    { label: '30 days', from: day(29), to: today },
    { label: 'This month', from: startOfMonth, to: today },
    { label: 'Last month', from: lastMonthStart, to: lastMonthEndStr },
    { label: 'Year', from: `${today.slice(0, 4)}-01-01`, to: today },
  ]
}
