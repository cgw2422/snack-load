'use client'

import { useState } from 'react'
import { Field, Input, Select } from '@/components/ui/Field'
import { adjustStockAction } from '@/app/(app)/inventory/actions'
import { ADJUSTMENT_REASONS } from '@/lib/schemas/inventory'
import { StockDocumentForm } from './StockDocumentForm'

export function AdjustForm({ locations }: { locations: { id: string; name: string; kind: string }[] }) {
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '')
  const [type, setType] = useState<string>('DAMAGE')

  const counting = type === 'COUNT_ADJUSTMENT'

  return (
    <StockDocumentForm
      // Remounting on a location change reloads on-hand figures for the lines.
      key={locationId}
      action={adjustStockAction}
      submitLabel={counting ? 'Record count' : 'Record adjustment'}
      locationId={locationId}
      showOnHand
      allowNegative={counting}
      quantityLabel={counting ? 'counted' : 'adjusted'}
      header={
        <>
          <Field label="Where" htmlFor="locationId">
            <Select
              id="locationId"
              name="locationId"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                  {location.kind === 'VEHICLE' ? ' (truck)' : ''}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Reason"
            htmlFor="type"
            hint={
              counting
                ? 'Enter what you actually counted. We work out the difference.'
                : 'Enter how much was lost. Stock comes off.'
            }
          >
            <Select id="type" name="type" value={type} onChange={(e) => setType(e.target.value)}>
              {ADJUSTMENT_REASONS.map((reason) => (
                <option key={reason.value} value={reason.value}>
                  {reason.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="What happened"
            htmlFor="notes"
            hint="Required — an adjustment nobody explained is one nobody can audit."
          >
            <Input id="notes" name="notes" required placeholder="Pallet dropped on the dock" />
          </Field>
        </>
      }
    />
  )
}
