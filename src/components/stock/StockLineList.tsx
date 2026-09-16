'use client'

import { Trash2 } from 'lucide-react'
import { formatQuantity } from '@/server/domain/uom'
import { QuantityStepper } from './QuantityStepper'
import type { StockLine } from './types'

/**
 * The editable lines of a stock document. Shared by receiving, adjustments,
 * transfers and truck loads so the interaction is identical wherever someone
 * counts something.
 */
export function StockLineList({
  lines,
  onChange,
  onRemove,
  showCost,
  showOnHand,
  allowNegative,
  quantityLabel = 'quantity',
}: {
  lines: StockLine[]
  onChange: (key: string, patch: Partial<StockLine>) => void
  onRemove: (key: string) => void
  showCost?: boolean
  showOnHand?: boolean
  allowNegative?: boolean
  quantityLabel?: string
}) {
  if (lines.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-ink-muted">
        Nothing added yet. Search above to add a product.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-line">
      {lines.map((line) => {
        const uom = line.uoms.find((u) => u.id === line.productUomId)
        const baseQuantity = (uom?.baseUnitsPerUom ?? 1) * line.quantity
        const unitsPerCase =
          line.uoms.find((u) => u.baseUnitsPerUom > 1)?.baseUnitsPerUom ?? 1

        return (
          <li key={line.key} className="px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{line.productName}</p>
                <p className="truncate text-xs text-ink-muted">
                  SKU {line.sku}
                  {showOnHand
                    ? ` · ${formatQuantity(line.onHand, unitsPerCase)} on hand`
                    : ''}
                </p>
              </div>

              <button
                type="button"
                aria-label={`Remove ${line.productName}`}
                onClick={() => onRemove(line.key)}
                className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-stop-500/5 hover:text-stop-600"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <QuantityStepper
                value={line.quantity}
                min={allowNegative ? -1_000_000 : 1}
                onChange={(quantity) => onChange(line.key, { quantity })}
                label={`${line.productName} ${quantityLabel}`}
              />

              <select
                value={line.productUomId}
                aria-label={`Unit for ${line.productName}`}
                onChange={(e) => onChange(line.key, { productUomId: e.target.value })}
                className="h-11 rounded-lg border border-line-strong bg-surface-raised px-2.5 text-sm font-medium text-ink focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/20"
              >
                {line.uoms.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                    {option.baseUnitsPerUom > 1 ? ` (${option.baseUnitsPerUom})` : ''}
                  </option>
                ))}
              </select>

              {showCost ? (
                <label className="flex items-center gap-1.5">
                  <span className="text-sm text-ink-muted">Cost</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={line.unitCost ?? ''}
                    aria-label={`Cost per ${uom?.label ?? 'unit'} of ${line.productName}`}
                    placeholder="0.00"
                    onChange={(e) => onChange(line.key, { unitCost: e.target.value })}
                    className="tnum h-11 w-24 rounded-lg border border-line-strong bg-surface-raised px-2.5 text-right text-base text-ink focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/20"
                  />
                </label>
              ) : null}

              {uom && uom.baseUnitsPerUom > 1 ? (
                <span className="tnum text-xs text-ink-subtle">
                  = {baseQuantity} {line.baseUomLabel.toLowerCase()}
                  {Math.abs(baseQuantity) === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
