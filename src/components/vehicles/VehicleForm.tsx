'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Check, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import { saveVehicleAction, type StockState } from '@/app/(app)/inventory/actions'

const EMPTY: StockState = {}

function Save({ isNew }: { isNew: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="primary" size="md" block disabled={pending}>
      {pending ? 'Saving…' : isNew ? 'Add truck' : 'Save changes'}
    </Button>
  )
}

export function VehicleForm({
  runners,
  vehicle,
}: {
  runners: { id: string; name: string }[]
  vehicle?: {
    id: string
    name: string
    truckNumber: string
    licensePlate: string | null
    runnerId: string | null
    active: boolean
    notes: string | null
  }
}) {
  const [state, action] = useActionState(saveVehicleAction, EMPTY)
  const [open, setOpen] = useState(Boolean(vehicle))

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="md" block onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden="true" />
        Add a truck
      </Button>
    )
  }

  return (
    <Card className="p-4">
      <form action={action} className="space-y-3">
        {vehicle ? <input type="hidden" name="vehicleId" value={vehicle.id} /> : null}

        {state.error ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{state.error}</span>
          </div>
        ) : null}

        {state.message ? (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-xl border border-cash-500/30 bg-cash-50 px-3.5 py-3 text-sm text-cash-700 dark:bg-cash-700/15 dark:text-cash-100"
          >
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{state.message}</span>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="name">
            <Input id="name" name="name" required defaultValue={vehicle?.name} placeholder="Truck #3" />
          </Field>
          <Field label="Truck number" htmlFor="truckNumber">
            <Input
              id="truckNumber"
              name="truckNumber"
              required
              defaultValue={vehicle?.truckNumber}
              placeholder="3"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="License plate" htmlFor="licensePlate">
            <Input
              id="licensePlate"
              name="licensePlate"
              defaultValue={vehicle?.licensePlate ?? ''}
              placeholder="OH SNK-103"
            />
          </Field>
          <Field label="Usual runner" htmlFor="assignedUserId">
            <Select id="assignedUserId" name="assignedUserId" defaultValue={vehicle?.runnerId ?? ''}>
              <option value="">Not assigned</option>
              {runners.map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Notes" htmlFor="notes">
          <Input id="notes" name="notes" defaultValue={vehicle?.notes ?? ''} />
        </Field>

        <label className="flex min-h-touch cursor-pointer items-center gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            name="active"
            defaultChecked={vehicle?.active ?? true}
            className="size-5 rounded border-line-strong text-navy-700 focus:ring-navy-500/30"
          />
          In service
        </label>

        <div className="flex gap-2">
          <Save isNew={!vehicle} />
          {!vehicle ? (
            <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  )
}
