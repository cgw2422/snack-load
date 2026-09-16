'use client'

import { useActionState, useEffect, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { useRouter } from 'next/navigation'
import { AlertCircle, CircleSlash, Clock, DoorClosed, MapPin, StickyNote } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import { arriveAction, completeStopAction, type RouteState } from '@/app/(app)/routes/actions'

const EMPTY: RouteState = {}

/**
 * The runner's stop screen (spec §21).
 *
 * The whole thing is built for one hand and a bright parking lot: 56px primary
 * actions, the destructive-ish outcomes behind a second tap, and no step that
 * needs typing unless the runner has something to say.
 */

function Arrive({ stopId, routeId }: { stopId: string; routeId: string }) {
  const { pending } = useFormStatus()
  const [position, setPosition] = useState<{ latitude: number; longitude: number } | null>(null)

  // Location is a nicety for the route report, never a gate: asking for it and
  // waiting would stall someone standing at a door.
  function capture() {
    if (!('geolocation' in navigator)) return
    navigator.geolocation.getCurrentPosition(
      (p) => setPosition({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => setPosition(null),
      { enableHighAccuracy: false, timeout: 3000, maximumAge: 60_000 },
    )
  }

  return (
    <>
      <input type="hidden" name="stopId" value={stopId} />
      <input type="hidden" name="routeId" value={routeId} />
      <input type="hidden" name="latitude" value={position?.latitude ?? ''} />
      <input type="hidden" name="longitude" value={position?.longitude ?? ''} />
      <Button
        type="submit"
        variant="accent"
        size="lg"
        block
        disabled={pending}
        onFocus={capture}
        onPointerDown={capture}
      >
        {pending ? 'Checking in…' : "I'm here"}
      </Button>
    </>
  )
}

export function ArriveForm({ stopId, routeId }: { stopId: string; routeId: string }) {
  return (
    <form action={arriveAction}>
      <Arrive stopId={stopId} routeId={routeId} />
    </form>
  )
}

const OUTCOMES = [
  { value: 'NO_SALE', label: 'No sale', icon: CircleSlash, hint: 'They are stocked up' },
  { value: 'STORE_CLOSED', label: 'Store closed', icon: DoorClosed, hint: 'Nobody there' },
  { value: 'RESCHEDULED', label: 'Come back later', icon: Clock, hint: 'Pick another day' },
] as const

function Finish({ label, variant }: { label: string; variant: 'cash' | 'secondary' }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant={variant} size="lg" block disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  )
}

export function CompleteStopForm({
  stopId,
  routeId,
  hasSale,
  defaultRescheduleDate,
}: {
  stopId: string
  routeId: string
  hasSale: boolean
  defaultRescheduleDate: string
}) {
  const [state, action] = useActionState(completeStopAction, EMPTY)
  const [outcome, setOutcome] = useState<string | null>(null)
  const router = useRouter()

  // A finished stop hands the runner straight on to the next one. Navigation is
  // a genuine external system, which is what an effect is for — doing it during
  // render would make render impure.
  useEffect(() => {
    if (!state.message) return
    router.push(
      state.routeId ? `/routes/${routeId}/stops/${state.routeId}` : `/routes/${routeId}`,
    )
  }, [state, router, routeId])

  return (
    <div className="space-y-3">
      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      ) : null}

      {outcome === null ? (
        <>
          <form action={action}>
            <input type="hidden" name="stopId" value={stopId} />
            <input type="hidden" name="routeId" value={routeId} />
            <input type="hidden" name="outcome" value="COMPLETED" />
            <Finish
              label={hasSale ? 'Finish stop' : 'Finish without a sale'}
              variant="cash"
            />
          </form>

          <div className="grid grid-cols-3 gap-2">
            {OUTCOMES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setOutcome(option.value)}
                className="flex min-h-touch flex-col items-center justify-center gap-1 rounded-xl border border-line-strong bg-surface-raised px-2 py-2.5 text-center transition-colors active:bg-surface-sunken"
              >
                <option.icon className="size-5 text-ink-muted" aria-hidden="true" />
                <span className="text-[11px] font-semibold leading-tight text-ink">
                  {option.label}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <Card className="p-4">
          <form action={action} className="space-y-3">
            <input type="hidden" name="stopId" value={stopId} />
            <input type="hidden" name="routeId" value={routeId} />
            <input type="hidden" name="outcome" value={outcome} />

            <div>
              <h2 className="text-[15px] font-semibold text-ink">
                {OUTCOMES.find((o) => o.value === outcome)?.label}
              </h2>
              <p className="text-xs text-ink-muted">
                {outcome === 'COMPLETED'
                  ? ''
                  : 'This store stays due and will turn up on your next run.'}
              </p>
            </div>

            {outcome === 'RESCHEDULED' ? (
              <Field label="Come back on" htmlFor="rescheduledToDate">
                <Input
                  id="rescheduledToDate"
                  name="rescheduledToDate"
                  type="date"
                  required
                  defaultValue={defaultRescheduleDate}
                />
              </Field>
            ) : null}

            <Field label="Why" htmlFor="reason" hint="Optional.">
              <Select id="reason" name="reason" defaultValue="">
                <option value="">Not specified</option>
                {REASONS[outcome as keyof typeof REASONS]?.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex gap-2">
              <Finish label="Save" variant="secondary" />
              <Button type="button" variant="ghost" size="lg" onClick={() => setOutcome(null)}>
                Back
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  )
}

const REASONS = {
  NO_SALE: ['Still fully stocked', 'Manager not in', 'Asked us to come back', 'Slow sales'],
  STORE_CLOSED: ['Closed for the day', 'Temporarily closed', 'Out of business', 'Holiday'],
  RESCHEDULED: ['Manager away', 'Deliveries not accepted today', 'Store too busy'],
} as const

export function NoteForm({
  stopId,
  routeId,
  action,
}: {
  stopId: string
  routeId: string
  action: (formData: FormData) => Promise<void>
}) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="md" block onClick={() => setOpen(true)}>
        <StickyNote className="size-4" aria-hidden="true" />
        Add a note
      </Button>
    )
  }

  return (
    <Card className="p-4">
      <form action={action} className="space-y-3">
        <input type="hidden" name="stopId" value={stopId} />
        <input type="hidden" name="routeId" value={routeId} />
        <Field label="Note" htmlFor="note" hint="Kept with this stop.">
          <Input id="note" name="note" required placeholder="New manager, asked for more Takis" />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="md" block>
            Save note
          </Button>
          <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

export function DirectionsLink({ mapQuery }: { mapQuery: string }) {
  return (
    <a
      href={`https://maps.google.com/?q=${encodeURIComponent(mapQuery)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex h-14 items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface-raised text-base font-semibold text-ink transition-colors active:bg-surface-sunken"
    >
      <MapPin className="size-4" aria-hidden="true" />
      Directions
    </a>
  )
}
