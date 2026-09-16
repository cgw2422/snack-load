'use client'

import { Field, Input, Select } from '@/components/ui/Field'
import { receiveStockAction } from '@/app/(app)/inventory/actions'
import { StockDocumentForm } from './StockDocumentForm'

export function ReceiveForm({
  warehouses,
  suppliers,
}: {
  warehouses: { id: string; name: string }[]
  suppliers: { id: string; name: string }[]
}) {
  const defaultWarehouse = warehouses[0]?.id ?? ''

  return (
    <StockDocumentForm
      action={receiveStockAction}
      submitLabel="Receive stock"
      locationId={defaultWarehouse}
      showCost
      quantityLabel="received"
      header={
        <>
          <Field label="Supplier" htmlFor="supplierId" hint="Optional — who sent this shipment.">
            <Select id="supplierId" name="supplierId" defaultValue="">
              <option value="">Not specified</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </Select>
          </Field>

          {warehouses.length > 1 ? (
            <Field label="Receive into" htmlFor="warehouseLocationId">
              <Select id="warehouseLocationId" name="warehouseLocationId" defaultValue={defaultWarehouse}>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <input type="hidden" name="warehouseLocationId" value={defaultWarehouse} />
          )}

          <Field
            label="Invoice number"
            htmlFor="referenceNumber"
            hint="Optional — we'll number it for you if you leave this blank."
          >
            <Input id="referenceNumber" name="referenceNumber" placeholder="394848" />
          </Field>

          <Field label="Notes" htmlFor="notes">
            <Input id="notes" name="notes" placeholder="Anything worth remembering" />
          </Field>
        </>
      }
    />
  )
}
