'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CalendarDays, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { Field, Select } from '@/components/ui/Field'
import { Pill } from '@/components/ui/Pill'
import { formatMoney } from '@/server/domain/money'
import { buildRouteAction, type RouteState } from '@/app/(app)/routes/actions'
import type { DueAccount } from '@/server/services/route.service'

const EMPTY: RouteState = {}

function Build({ count }: { count: number }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" size="lg" block disabled={pending || count === 0}>
      {pending ? 'Building…' : count === 0 ? 'Nothing selected' : `Build route · ${count} stops`}
    </Button>
  )
}

/**
 * The planner (spec §12). Pick a route and a day, see who is due, uncheck
 * anyone you are skipping, and build.
 *
 * Overdue accounts are flagged rather than buried: they are the reason a
 * planner opens this screen rather than just running last week's route again.
 */
export function RoutePlanner({
  templates,
  runners,
  vehicles,
  serviceDate,
  templateId,
  due,
  notDue,
  dayName,
  currency,
}: {
  templates: { id: string; name: string; dayOfWeek: string | null; runnerId: string | null; vehicleId: string | null }[]
  runners: { id: string; name: string }[]
  vehicles: { id: string; name: string }[]
  serviceDate: string
  templateId: string
  due: DueAccount[]
  notDue: DueAccount[]
  dayName: string
  currency: string
}) {
  const [state, action] = useActionState(buildRouteAction, EMPTY)
  const template = templates.find((t) => t.id === templateId)

  const selectable = due.filter((a) => !a.alreadyScheduled)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectable.map((a) => a.customerId)),
  )

  function toggle(customerId: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(customerId)) next.delete(customerId)
      else next.add(customerId)
      return next
    })
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="serviceDate" value={serviceDate} />
      <input type="hidden" name="routeTemplateId" value={templateId} />

      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      ) : null}

      <Card className="space-y-3 p-4">
        <Field label="Runner" htmlFor="runnerUserId">
          <Select
            id="runnerUserId"
            name="runnerUserId"
            defaultValue={template?.runnerId ?? runners[0]?.id ?? ''}
            required
          >
            {runners.map((runner) => (
              <option key={runner.id} value={runner.id}>
                {runner.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Truck" htmlFor="vehicleId" hint="Optional.">
          <Select id="vehicleId" name="vehicleId" defaultValue={template?.vehicleId ?? ''}>
            <option value="">Not specified</option>
            {vehicles.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.name}
              </option>
            ))}
          </Select>
        </Field>

        <label className="flex min-h-touch cursor-pointer items-center gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            name="optimize"
            defaultChecked
            className="size-5 rounded border-line-strong text-navy-700 focus:ring-navy-500/30"
          />
          Put the stops in the shortest driving order
        </label>
      </Card>

      <Card>
        <CardHeader
          title={
            due.length === 0
              ? `Nothing due on ${dayName.toLowerCase()}`
              : `${due.length} ${due.length === 1 ? 'account' : 'accounts'} due`
          }
          action={
            selectable.length > 0 ? (
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    selected.size === selectable.length
                      ? new Set()
                      : new Set(selectable.map((a) => a.customerId)),
                  )
                }
                className="text-sm font-semibold text-navy-600 hover:underline"
              >
                {selected.size === selectable.length ? 'Clear all' : 'Select all'}
              </button>
            ) : null
          }
        />

        {due.length === 0 ? (
          <p className="flex items-center gap-2 px-4 pb-4 text-sm text-ink-muted">
            <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
            This route runs on a different day, or every account has been visited this cycle.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {due.map((account) => (
              <li key={account.customerId} className="flex items-center gap-2">
                <label
                  className={`flex size-touch shrink-0 items-center justify-center pl-2 ${
                    account.alreadyScheduled ? 'opacity-40' : 'cursor-pointer'
                  }`}
                >
                  <span className="sr-only">Include {account.name}</span>
                  <input
                    type="checkbox"
                    name="customerIds"
                    value={account.customerId}
                    checked={selected.has(account.customerId)}
                    disabled={account.alreadyScheduled}
                    onChange={() => toggle(account.customerId)}
                    className="size-5 rounded border-line-strong text-navy-700 focus:ring-navy-500/30"
                  />
                </label>

                <span className="min-w-0 flex-1 py-3">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-ink">{account.name}</span>
                    {account.daysOverdue > 0 ? (
                      <Pill tone="alert">
                        <TriangleAlert className="size-3" aria-hidden="true" />
                        {account.daysOverdue}d overdue
                      </Pill>
                    ) : null}
                    {account.alreadyScheduled ? <Pill>On another route</Pill> : null}
                  </span>
                  <span className="block truncate text-xs text-ink-muted">
                    #{account.accountNumber} · {account.addressLine || 'No address'}
                  </span>
                  <span className="block text-xs text-ink-subtle">{account.frequencyLabel}</span>
                </span>

                {Number(account.balance) > 0 ? (
                  <span className="tnum shrink-0 pr-4 text-sm font-semibold text-alert-600">
                    {formatMoney(account.balance, currency)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {due.length > 0 ? <Build count={selected.size} /> : null}

      {notDue.length > 0 ? (
        <Card>
          <CardHeader title={`${notDue.length} not due yet`} />
          <ul className="divide-y divide-line">
            {notDue.slice(0, 8).map((account) => (
              <li key={account.customerId} className="px-4 py-2.5">
                <span className="block truncate text-sm text-ink-muted">{account.name}</span>
                <span className="block text-xs text-ink-subtle">{account.frequencyLabel}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </form>
  )
}
