'use client'

import { useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { SlidersHorizontal, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import { Pill } from '@/components/ui/Pill'

const STATUSES = [
  { value: 'all', label: 'Any status' },
  { value: 'open', label: 'Still owed' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
  { value: 'voided', label: 'Voided' },
]

/**
 * Date, status and amount filters for the receipt book (spec §25).
 *
 * The state lives in the URL, so a filtered view is a link somebody can send to
 * the office, and the back button undoes a filter instead of leaving the page.
 * The panel starts collapsed on a phone and opens with a tap; the chips below
 * the button say what is currently applied, which is the part that is easy to
 * forget when a total looks wrong.
 */
export function ReceiptFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const current = {
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    status: params.get('status') ?? 'all',
    minAmount: params.get('minAmount') ?? '',
    maxAmount: params.get('maxAmount') ?? '',
  }

  const applied = [
    current.from ? `From ${current.from}` : null,
    current.to ? `To ${current.to}` : null,
    current.status !== 'all'
      ? (STATUSES.find((s) => s.value === current.status)?.label ?? current.status)
      : null,
    current.minAmount ? `Over $${current.minAmount}` : null,
    current.maxAmount ? `Under $${current.maxAmount}` : null,
  ].filter((chip): chip is string => chip !== null)

  const [open, setOpen] = useState(applied.length > 0)

  function apply(formData: FormData) {
    const query = new URLSearchParams(params.toString())
    for (const key of ['from', 'to', 'status', 'minAmount', 'maxAmount'] as const) {
      const value = String(formData.get(key) ?? '').trim()
      if (value && value !== 'all') query.set(key, value)
      else query.delete(key)
    }
    // A new filter starts at the first page; page 7 of the old result set is
    // meaningless against the new one.
    query.delete('page')
    router.replace(`${pathname}?${query}`, { scroll: false })
  }

  function clear() {
    const query = new URLSearchParams(params.toString())
    for (const key of ['from', 'to', 'status', 'minAmount', 'maxAmount', 'page']) {
      query.delete(key)
    }
    router.replace(`${pathname}?${query}`, { scroll: false })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(!open)}>
          <SlidersHorizontal className="size-4" aria-hidden="true" />
          Filters
          {applied.length > 0 ? (
            <span className="ml-1 rounded-full bg-navy-800 px-1.5 text-[11px] font-bold text-white">
              {applied.length}
            </span>
          ) : null}
        </Button>

        {applied.map((chip) => (
          <Pill key={chip} tone="navy">
            {chip}
          </Pill>
        ))}

        {applied.length > 0 ? (
          <button
            type="button"
            onClick={clear}
            className="inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-ink"
          >
            <X className="size-3" aria-hidden="true" />
            Clear
          </button>
        ) : null}
      </div>

      {open ? (
        <Card className="p-4">
          <form action={apply} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From" htmlFor="filter-from">
                <Input id="filter-from" name="from" type="date" defaultValue={current.from} />
              </Field>
              <Field label="To" htmlFor="filter-to">
                <Input id="filter-to" name="to" type="date" defaultValue={current.to} />
              </Field>
            </div>

            <Field label="Payment status" htmlFor="filter-status">
              <Select id="filter-status" name="status" defaultValue={current.status}>
                {STATUSES.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Amount from" htmlFor="filter-min">
                <Input
                  id="filter-min"
                  name="minAmount"
                  inputMode="decimal"
                  placeholder="0.00"
                  defaultValue={current.minAmount}
                />
              </Field>
              <Field label="Amount to" htmlFor="filter-max">
                <Input
                  id="filter-max"
                  name="maxAmount"
                  inputMode="decimal"
                  placeholder="No limit"
                  defaultValue={current.maxAmount}
                />
              </Field>
            </div>

            <Button type="submit" variant="primary" size="lg" block>
              Apply filters
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  )
}
