'use client'

import { useState } from 'react'
import { Sparkles, Truck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import { truckLoadAction } from '@/app/(app)/inventory/actions'
import { StockDocumentForm } from './StockDocumentForm'
import type { StockLine } from './types'
import type { SuggestedLoadLine } from '@/server/services/truckload.service'

/**
 * Loading a truck (spec §19).
 *
 * The suggestion is offered, never applied: a person who knows this route is
 * better informed than eight weeks of averages, and the numbers stay editable
 * until they post.
 */
export function LoadTruckForm({
  vehicles,
  warehouses,
  routes,
  suggestions,
  direction,
}: {
  vehicles: {
    id: string
    name: string
    truckNumber: string
    runnerName: string | null
    /** The truck's own stock location — what an unload reads its on-hand from. */
    locationId: string
  }[]
  warehouses: { id: string; name: string }[]
  routes: { id: string; name: string }[]
  suggestions: Record<string, SuggestedLoadLine[]>
  direction: 'LOAD' | 'UNLOAD'
}) {
  const [vehicleId, setVehicleId] = useState(vehicles[0]?.id ?? '')
  const [seed, setSeed] = useState<StockLine[]>([])
  const [applied, setApplied] = useState(false)

  const warehouse = warehouses[0]?.id ?? ''
  const available = suggestions[vehicleId] ?? []

  // A different truck means different history and different stock on board.
  function chooseVehicle(next: string) {
    setVehicleId(next)
    setSeed([])
    setApplied(false)
  }

  function applySuggestion() {
    setSeed(
      available.map((line) => ({
        key: crypto.randomUUID(),
        productId: line.productId,
        productName: line.name,
        sku: line.sku,
        baseUomLabel: line.uomLabel,
        uoms: [
          {
            id: line.productUomId,
            code: 'CASE',
            label: line.uomLabel,
            baseUnitsPerUom: line.baseUnitsPerUom,
            price: '0',
            isDefaultSaleUom: true,
          },
        ],
        productUomId: line.productUomId,
        quantity: line.suggestedQuantity,
        onHand: line.onTruck,
      })),
    )
    setApplied(true)
  }

  const loading = direction === 'LOAD'

  return (
    <div className="space-y-4">
      {loading && available.length > 0 && !applied ? (
        <Card className="overflow-hidden">
          <div className="flex items-start gap-3 border-b border-line bg-flame-50 px-4 py-3 dark:bg-flame-700/15">
            <Sparkles className="mt-0.5 size-5 shrink-0 text-flame-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">Suggested load</p>
              <p className="text-xs text-ink-muted">
                From what these stores bought over the last eight weeks, less what is already
                aboard. Every figure stays editable.
              </p>
            </div>
          </div>

          <ul className="max-h-64 divide-y divide-line overflow-y-auto">
            {available.slice(0, 8).map((line) => (
              <li key={line.productId} className="flex items-center gap-3 px-4 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{line.name}</span>
                  <span className="block truncate text-xs text-ink-subtle">{line.rationale}</span>
                </span>
                <span className="tnum shrink-0 text-sm font-bold text-ink">
                  {line.suggestedQuantity} {line.uomLabel.toLowerCase()}
                  {line.suggestedQuantity === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>

          <div className="border-t border-line p-3">
            <Button type="button" variant="secondary" size="md" block onClick={applySuggestion}>
              Use this suggestion ({available.length} products)
            </Button>
          </div>
        </Card>
      ) : null}

      <StockDocumentForm
        key={`${vehicleId}-${applied}`}
        action={truckLoadAction}
        submitLabel={loading ? 'Load truck' : 'Unload truck'}
        locationId={loading ? warehouse : vehicles.find((v) => v.id === vehicleId)?.locationId}
        showOnHand
        initialLines={seed}
        quantityLabel={loading ? 'loaded' : 'returned'}
        header={
          <>
            <input type="hidden" name="direction" value={direction} />
            <input type="hidden" name="warehouseLocationId" value={warehouse} />

            <Field label="Truck" htmlFor="vehicleId">
              <Select
                id="vehicleId"
                name="vehicleId"
                value={vehicleId}
                onChange={(e) => chooseVehicle(e.target.value)}
              >
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.name}
                    {vehicle.runnerName ? ` — ${vehicle.runnerName}` : ''}
                  </option>
                ))}
              </Select>
            </Field>

            {loading && routes.length > 0 ? (
              <Field label="For which route" htmlFor="routeId" hint="Optional.">
                <Select id="routeId" name="routeId" defaultValue="">
                  <option value="">Not specified</option>
                  {routes.map((route) => (
                    <option key={route.id} value={route.id}>
                      {route.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <Field label="Notes" htmlFor="notes">
              <Input id="notes" name="notes" placeholder="Anything worth remembering" />
            </Field>
          </>
        }
      />

      {vehicles.length === 0 ? (
        <Card className="flex items-center gap-3 p-4">
          <Truck className="size-5 shrink-0 text-ink-subtle" aria-hidden="true" />
          <p className="text-sm text-ink-muted">
            No trucks yet. Add one before you can load it.
          </p>
        </Card>
      ) : null}
    </div>
  )
}
