'use client'

import { useActionState, useCallback, useState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ReactNode } from 'react'
import { AlertCircle, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import type { StockState } from '@/app/(app)/inventory/actions'
import { ProductPicker } from './ProductPicker'
import { StockLineList } from './StockLineList'
import type { ProductHit, ProductUomOption, StockLine } from './types'

const EMPTY: StockState = {}

function Submit({ label, count }: { label: string; count: number }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" size="lg" block disabled={pending || count === 0}>
      {pending ? 'Saving…' : count === 0 ? label : `${label} · ${count} ${count === 1 ? 'product' : 'products'}`}
    </Button>
  )
}

/**
 * The shared shell for every stock document: receiving, adjustments, transfers
 * and truck loads. They differ in their header fields and in which columns the
 * lines show — not in how a person adds a product and counts it.
 *
 * The idempotency key is minted when the form mounts, not when submit is
 * pressed, so a retry after a dropped connection is a replay rather than a
 * second posting (docs/02 §I1).
 */
export function StockDocumentForm({
  action,
  submitLabel,
  locationId,
  header,
  footer,
  showCost,
  showOnHand,
  allowNegative,
  initialLines = [],
  quantityLabel,
}: {
  action: (prev: StockState, formData: FormData) => Promise<StockState>
  submitLabel: string
  /** Stock is read from here for the on-hand column. */
  locationId?: string
  header?: ReactNode
  footer?: ReactNode
  showCost?: boolean
  showOnHand?: boolean
  allowNegative?: boolean
  initialLines?: StockLine[]
  quantityLabel?: string
}) {
  const [state, formAction] = useActionState(action, EMPTY)
  const [lines, setLines] = useState<StockLine[]>(initialLines)
  // Minted when the form mounts, not when submit is pressed, so a retry after a
  // dropped connection replays rather than posting twice (docs/02 §I1).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [settled, setSettled] = useState<StockState | null>(null)

  // Adjusting state during render — React's documented alternative to an effect
  // that immediately sets state. Once the server confirms a posting, the sheet
  // clears and the next document gets its own key.
  if (state.done && state !== settled) {
    setSettled(state)
    setLines([])
    setIdempotencyKey(crypto.randomUUID())
  }

  const addProduct = useCallback((product: ProductHit, uoms: ProductUomOption[]) => {
    const usable = uoms.length > 0
      ? uoms
      : [{ id: 'base', code: 'EACH', label: product.baseUomLabel, baseUnitsPerUom: 1, price: product.unitPrice, isDefaultSaleUom: true }]

    // Default to the largest packaging: warehouses count cases.
    const preferred = [...usable].sort((a, b) => b.baseUnitsPerUom - a.baseUnitsPerUom)[0]

    setLines((current) => {
      if (current.some((l) => l.productId === product.id)) return current
      return [
        ...current,
        {
          key: crypto.randomUUID(),
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          baseUomLabel: product.baseUomLabel,
          uoms: usable,
          productUomId: preferred.id,
          quantity: 1,
          unitCost: showCost ? '' : undefined,
          onHand: product.onHand ?? product.onHandBaseUnits,
        },
      ]
    })
  }, [showCost])

  const patch = useCallback((key: string, changes: Partial<StockLine>) => {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...changes } : l)))
  }, [])

  const remove = useCallback((key: string) => {
    setLines((current) => current.filter((l) => l.key !== key))
  }, [])

  const payload = lines.map((line) => ({
    productId: line.productId,
    productUomId: line.productUomId,
    quantity: line.quantity,
    ...(showCost ? { unitCost: line.unitCost || '0' } : {}),
  }))

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="lines" value={JSON.stringify(payload)} />

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

      {header ? <Card className="space-y-3 p-4">{header}</Card> : null}

      <ProductPicker
        locationId={locationId}
        onPick={addProduct}
        excludeIds={new Set(lines.map((l) => l.productId))}
      />

      <Card>
        <StockLineList
          lines={lines}
          onChange={patch}
          onRemove={remove}
          showCost={showCost}
          showOnHand={showOnHand}
          allowNegative={allowNegative}
          quantityLabel={quantityLabel}
        />
      </Card>

      {footer}

      <Submit label={submitLabel} count={lines.length} />
    </form>
  )
}
