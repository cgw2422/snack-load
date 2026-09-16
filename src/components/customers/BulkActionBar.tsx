'use client'

import { useActionState, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import { bulkCustomerAction, type BulkState } from '@/app/(app)/customers/actions'

const EMPTY: BulkState = {}

type Route = { id: string; name: string; runnerId: string | null; runnerName: string | null }

const ACTIONS = [
  { value: 'assign_route', label: 'Assign to route' },
  { value: 'assign_runner', label: 'Assign to runner' },
  { value: 'set_visit_day', label: 'Change visit day' },
  { value: 'set_frequency', label: 'Change frequency' },
  { value: 'set_terms', label: 'Change payment terms' },
  { value: 'set_price_group', label: 'Apply pricing group' },
  { value: 'activate', label: 'Activate' },
  { value: 'deactivate', label: 'Deactivate' },
]

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']
const FREQUENCIES = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'BIWEEKLY', label: 'Every two weeks' },
  { value: 'TRIWEEKLY', label: 'Every three weeks' },
  { value: 'MONTHLY', label: 'Monthly' },
]
const TERMS = ['COD', 'NET7', 'NET15', 'NET30', 'NET60']

function Apply({ count }: { count: number }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" size="md" disabled={pending || count === 0}>
      {pending ? 'Applying…' : `Apply to ${count}`}
    </Button>
  )
}

/**
 * Wraps the customer list so the checkboxes inside it and this bar are one form
 * (spec §11). The bar only appears once something is selected — on a phone it
 * would otherwise eat a third of the screen for nothing.
 */
export function BulkActionBar({
  canEdit,
  routes,
  priceGroups,
  children,
}: {
  canEdit: boolean
  routes: Route[]
  priceGroups: { id: string; name: string }[]
  children: ReactNode
}) {
  const [state, formAction] = useActionState(bulkCustomerAction, EMPTY)
  const [selected, setSelected] = useState(0)
  const [action, setAction] = useState('assign_route')
  const form = useRef<HTMLFormElement>(null)
  const actionId = useId()

  // The checkboxes are rendered by the server component inside this form, so the
  // count is read from the DOM rather than mirrored into React state.
  function recount() {
    const boxes = form.current?.querySelectorAll<HTMLInputElement>('input[name="customerIds"]')
    setSelected(boxes ? [...boxes].filter((b) => b.checked).length : 0)
  }

  useEffect(() => {
    if (state.message) {
      form.current?.reset()
      recount()
    }
  }, [state.message])

  if (!canEdit) return <>{children}</>

  const runners = routes.filter((r) => r.runnerId)

  return (
    <form ref={form} action={formAction} onChange={recount}>
      {state.error ? (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      ) : null}

      {state.message ? (
        <div
          role="status"
          className="mb-3 flex items-start gap-2.5 rounded-xl border border-cash-500/30 bg-cash-50 px-3.5 py-3 text-sm text-cash-700 dark:bg-cash-700/15 dark:text-cash-100"
        >
          <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.message}</span>
        </div>
      ) : null}

      {children}

      {selected > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface-raised p-3 shadow-[0_-4px_16px_rgba(15,23,42,0.08)] safe-bottom md:sticky md:bottom-4 md:mt-4 md:rounded-card md:border md:shadow-lg">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
            <span className="tnum flex h-9 items-center rounded-full bg-navy-800 px-3 text-sm font-bold text-white">
              {selected} selected
            </span>

            <label className="sr-only" htmlFor={actionId}>
              Bulk action
            </label>
            <Select
              id={actionId}
              name="action"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="h-11 w-auto min-w-48 flex-1"
            >
              {ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>

            {action === 'assign_route' ? (
              <Select name="routeTemplateId" required className="h-11 w-auto min-w-40 flex-1">
                <option value="">Choose a route…</option>
                {routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.runnerName ? ` — ${r.runnerName}` : ''}
                  </option>
                ))}
              </Select>
            ) : null}

            {action === 'assign_runner' ? (
              <Select name="runnerUserId" required className="h-11 w-auto min-w-40 flex-1">
                <option value="">Choose a runner…</option>
                {runners.map((r) => (
                  <option key={r.runnerId!} value={r.runnerId!}>
                    {r.runnerName} — {r.name}
                  </option>
                ))}
              </Select>
            ) : null}

            {action === 'set_visit_day' ? (
              <Select name="dayOfWeek" required className="h-11 w-auto min-w-36 flex-1">
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d.charAt(0) + d.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            ) : null}

            {action === 'set_frequency' ? (
              <Select name="frequency" required className="h-11 w-auto min-w-40 flex-1">
                {FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            ) : null}

            {action === 'set_terms' ? (
              <Select name="paymentTermsCode" required className="h-11 w-auto min-w-32 flex-1">
                {TERMS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            ) : null}

            {action === 'set_price_group' ? (
              <Select name="priceGroupId" className="h-11 w-auto min-w-40 flex-1">
                <option value="">No pricing group</option>
                {priceGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            ) : null}

            <Apply count={selected} />

            <Button
              type="reset"
              variant="ghost"
              size="md"
              onClick={() => setTimeout(recount, 0)}
              aria-label="Clear selection"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  )
}
