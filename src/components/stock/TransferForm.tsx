'use client'

import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { Field, Input, Select } from '@/components/ui/Field'
import { transferStockAction } from '@/app/(app)/inventory/actions'
import { StockDocumentForm } from './StockDocumentForm'

export function TransferForm({
  locations,
}: {
  locations: { id: string; name: string; kind: string }[]
}) {
  const [from, setFrom] = useState(locations[0]?.id ?? '')
  const [to, setTo] = useState(locations[1]?.id ?? '')

  return (
    <StockDocumentForm
      key={from}
      action={transferStockAction}
      submitLabel="Transfer stock"
      locationId={from}
      showOnHand
      quantityLabel="transferred"
      header={
        <>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <Field label="From" htmlFor="fromLocationId">
              <Select
                id="fromLocationId"
                name="fromLocationId"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </Select>
            </Field>

            <ArrowRight
              className="mx-auto hidden size-5 shrink-0 self-center text-ink-subtle sm:block"
              aria-hidden="true"
            />

            <Field label="To" htmlFor="toLocationId">
              <Select
                id="toLocationId"
                name="toLocationId"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              >
                {locations
                  .filter((location) => location.id !== from)
                  .map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>

          <Field label="Notes" htmlFor="notes">
            <Input id="notes" name="notes" placeholder="Why this is moving" />
          </Field>
        </>
      }
    />
  )
}
