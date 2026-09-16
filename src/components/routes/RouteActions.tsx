'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Check, Shuffle, UserRoundCog } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import { optimizeRouteAction, reassignAction, type RouteState } from '@/app/(app)/routes/actions'

const EMPTY: RouteState = {}

function Notice({ state }: { state: RouteState }) {
  if (state.error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
      >
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{state.error}</span>
      </div>
    )
  }
  if (state.message) {
    return (
      <div
        role="status"
        className="flex items-start gap-2.5 rounded-xl border border-cash-500/30 bg-cash-50 px-3.5 py-3 text-sm text-cash-700 dark:bg-cash-700/15 dark:text-cash-100"
      >
        <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{state.message}</span>
      </div>
    )
  }
  return null
}

function Pending({ children }: { children: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="secondary" size="md" disabled={pending}>
      <Shuffle className={pending ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
      {pending ? 'Working…' : children}
    </Button>
  )
}

export function OptimizeButton({ routeId }: { routeId: string }) {
  const [state, action] = useActionState(optimizeRouteAction, EMPTY)
  return (
    <div className="space-y-3">
      <Notice state={state} />
      <form action={action}>
        <input type="hidden" name="routeId" value={routeId} />
        <Pending>Reorder for the shortest drive</Pending>
      </form>
    </div>
  )
}

/**
 * Moving work when a runner calls off (spec §14). Deliberately a small, obvious
 * form: this is used in a hurry, usually before 7am.
 */
export function ReassignPanel({
  routeId,
  runners,
  pendingStops,
}: {
  routeId: string
  runners: { id: string; name: string }[]
  pendingStops: { id: string; sequence: number; customerName: string }[]
}) {
  const [state, action] = useActionState(reassignAction, EMPTY)
  const [open, setOpen] = useState(false)
  const [partial, setPartial] = useState(false)

  if (pendingStops.length === 0) return null

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="md" block onClick={() => setOpen(true)}>
        <UserRoundCog className="size-4" aria-hidden="true" />
        Move these stops to someone else
      </Button>
    )
  }

  return (
    <Card className="p-4">
      <form action={action} className="space-y-3">
        <input type="hidden" name="routeId" value={routeId} />
        <Notice state={state} />

        <div>
          <h2 className="text-[15px] font-semibold text-ink">Move remaining stops</h2>
          <p className="text-xs text-ink-muted">
            Stops already worked stay where they happened, with the original runner&apos;s name on
            them.
          </p>
        </div>

        <Field label="Who is taking them" htmlFor="toUserId">
          <Select id="toUserId" name="toUserId" required defaultValue="">
            <option value="" disabled>
              Choose a runner…
            </option>
            {runners.map((runner) => (
              <option key={runner.id} value={runner.id}>
                {runner.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Reason" htmlFor="reason" hint="Optional — kept with the route history.">
          <Input id="reason" name="reason" placeholder="Mike called off" />
        </Field>

        <label className="flex min-h-touch cursor-pointer items-center gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={partial}
            onChange={(e) => setPartial(e.target.checked)}
            className="size-5 rounded border-line-strong text-navy-700 focus:ring-navy-500/30"
          />
          Only move some of them
        </label>

        {partial ? (
          <ul className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
            {pendingStops.map((stop) => (
              <li key={stop.id}>
                <label className="flex min-h-touch cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm text-ink hover:bg-surface-sunken">
                  <input
                    type="checkbox"
                    name="stopIds"
                    value={stop.id}
                    className="size-5 rounded border-line-strong text-navy-700 focus:ring-navy-500/30"
                  />
                  <span className="tnum w-6 text-xs text-ink-subtle">{stop.sequence}</span>
                  <span className="truncate">{stop.customerName}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-muted">
            All {pendingStops.length} unworked stops will move.
          </p>
        )}

        <div className="flex gap-2">
          <Button type="submit" variant="accent" size="md" block>
            Move stops
          </Button>
          <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
