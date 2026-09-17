'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { useRouter } from 'next/navigation'
import { AlertCircle, Check, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import { Pill } from '@/components/ui/Pill'
import { createReturnAction, type CreditState } from '@/app/(app)/credits/actions'
import type { ReturnableLine } from '@/server/services/return.service'
import { pluralize } from '@/server/domain/uom'

const EMPTY: CreditState = {}

const REASONS = [
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'WRONG_ITEM', label: 'Wrong product' },
  { value: 'UNSOLD', label: 'Customer overstock / unsold' },
  { value: 'SWAP', label: 'Product swap' },
  { value: 'PRICING_ERROR', label: 'Pricing error' },
  { value: 'DELIVERY_ERROR', label: 'Delivery error' },
  { value: 'OTHER', label: 'Other' },
]

const DISPOSITIONS = [
  { value: 'RESTOCK_TRUCK', label: 'Back on my truck — sellable' },
  { value: 'RESTOCK_WAREHOUSE', label: 'Back to the warehouse — sellable' },
  { value: 'DAMAGED', label: 'Take it, write it off — damaged' },
  { value: 'EXPIRED', label: 'Take it, write it off — expired' },
  { value: 'SUPPLIER_RETURN', label: 'Take it, send it back to the supplier' },
  { value: 'NONE', label: 'Nothing comes back — credit only' },
]

/** The reason usually implies the disposition; offering it saves a tap. */
const SUGGESTED: Record<string, string> = {
  DAMAGED: 'DAMAGED',
  EXPIRED: 'EXPIRED',
  UNSOLD: 'RESTOCK_TRUCK',
  WRONG_ITEM: 'RESTOCK_TRUCK',
  SWAP: 'RESTOCK_TRUCK',
  PRICING_ERROR: 'NONE',
  DELIVERY_ERROR: 'RESTOCK_TRUCK',
  OTHER: 'RESTOCK_TRUCK',
}

type Line = { saleItemId: string; quantity: number; disposition: string }

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="accent" size="lg" block disabled={pending || disabled}>
      {pending ? 'Recording…' : 'Record the return'}
    </Button>
  )
}

/**
 * Taking goods back at the counter (spec §16).
 *
 * The runner picks lines off the original invoice, says how many and why, says
 * where the goods go, and says what the money does. Those last two are separate
 * questions on purpose: a damaged case still earns a credit, and a pricing
 * correction earns one with nothing coming back at all.
 *
 * Quantities are capped at what is still returnable — but the cap shown here is
 * a convenience, not the guard. The server recomputes it against every earlier
 * return and refuses anything over (spec §22 scenario E).
 */
export function ReturnScreen({
  saleId,
  saleNumber,
  customerName,
  lines,
  routeStopId,
  currency,
  canRefund,
}: {
  saleId: string
  saleNumber: string
  customerName: string
  lines: ReturnableLine[]
  routeStopId?: string
  currency: string
  canRefund: boolean
}) {
  const [state, action] = useActionState(
    async (previous: CreditState, formData: FormData) => {
      idempotencyKey.current ??= crypto.randomUUID()
      formData.set('idempotencyKey', idempotencyKey.current)
      return createReturnAction(previous, formData)
    },
    EMPTY,
  )
  const [reason, setReason] = useState('UNSOLD')
  const [selected, setSelected] = useState<Line[]>([])
  const [financialAction, setFinancialAction] = useState('APPLY_TO_BALANCE')
  const router = useRouter()

  // Minted at submit, outside render, and kept across a retry: a double-tap in
  // a store with no signal replays rather than crediting twice (docs/02 §I1).
  // Generating it during render would differ between the server pass and the
  // client pass and tear hydration.
  const idempotencyKey = useRef<string | null>(null)

  useEffect(() => {
    if (state.creditMemoId) router.push(`/credits/${state.creditMemoId}`)
    else if (state.returnId) router.push(`/receipts/${saleId}`)
  }, [state.creditMemoId, state.returnId, router, saleId])

  const returnable = lines.filter((line) => line.returnableQuantity > 0)

  function lineFor(saleItemId: string): Line | undefined {
    return selected.find((l) => l.saleItemId === saleItemId)
  }

  function setQuantity(line: ReturnableLine, quantity: number) {
    const clamped = Math.max(0, Math.min(line.returnableQuantity, quantity))
    setSelected((current) => {
      const without = current.filter((l) => l.saleItemId !== line.saleItemId)
      if (clamped === 0) return without
      const existing = current.find((l) => l.saleItemId === line.saleItemId)
      return [
        ...without,
        {
          saleItemId: line.saleItemId,
          quantity: clamped,
          disposition: existing?.disposition ?? SUGGESTED[reason] ?? 'RESTOCK_TRUCK',
        },
      ]
    })
  }

  function setDisposition(saleItemId: string, disposition: string) {
    setSelected((current) =>
      current.map((l) => (l.saleItemId === saleItemId ? { ...l, disposition } : l)),
    )
  }

  // A rough total so the runner knows what they are about to credit. The
  // authoritative figure is computed on the server from the original prices.
  const estimate = selected.reduce((total, line) => {
    const source = lines.find((l) => l.saleItemId === line.saleItemId)
    return total + (source ? Number(source.unitPrice) * line.quantity : 0)
  }, 0)

  return (
    <form action={action} className="space-y-4 pb-64 md:pb-4">
      <input type="hidden" name="saleId" value={saleId} />
      <input type="hidden" name="routeStopId" value={routeStopId ?? ''} />
      <input type="hidden" name="lines" value={JSON.stringify(selected)} />

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

      <Card className="p-4">
        <h1 className="text-lg font-extrabold text-ink">Return items</h1>
        <p className="text-xs text-ink-muted">
          {customerName} · against {saleNumber}
        </p>
      </Card>

      <Card className="p-4">
        <Field label="Why is it coming back?" htmlFor="return-reason">
          <Select
            id="return-reason"
            name="reason"
            value={reason}
            onChange={(event) => {
              const next = event.target.value
              setReason(next)
              // Follow the reason unless the runner has already overridden a line.
              const suggestion = SUGGESTED[next]
              if (suggestion) {
                setSelected((current) => current.map((l) => ({ ...l, disposition: suggestion })))
              }
            }}
          >
            {REASONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      <Card>
        {returnable.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-muted">
            Everything on {saleNumber} has already been returned.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {returnable.map((line) => {
              const chosen = lineFor(line.saleItemId)
              const quantity = chosen?.quantity ?? 0

              return (
                <li key={line.saleItemId} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{line.name}</p>
                      <p className="text-xs text-ink-muted">
                        Sold {line.soldQuantity} × {line.uomLabel.toLowerCase()} at{' '}
                        {money(line.unitPrice, currency)}
                      </p>
                      {line.returnedBaseQuantity > 0 ? (
                        <Pill tone="navy">
                          {line.returnableQuantity} of {line.soldQuantity} still returnable
                        </Pill>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      aria-label={`One fewer ${line.name}`}
                      onClick={() => setQuantity(line, quantity - 1)}
                      className="flex size-11 items-center justify-center rounded-lg border border-line-strong bg-surface-raised active:bg-surface-sunken"
                    >
                      <Minus className="size-4" aria-hidden="true" />
                    </button>

                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label={`${line.name} returning`}
                      value={quantity}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) =>
                        setQuantity(line, Number(event.target.value.replace(/\D/g, '')) || 0)
                      }
                      className="tnum h-11 w-14 rounded-lg border border-line-strong bg-surface-raised text-center text-base font-bold"
                    />

                    <button
                      type="button"
                      aria-label={`One more ${line.name}`}
                      onClick={() => setQuantity(line, quantity + 1)}
                      className="flex size-11 items-center justify-center rounded-lg border border-line-strong bg-surface-raised active:bg-surface-sunken"
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </button>

                    <span className="text-xs text-ink-subtle">
                      of {line.returnableQuantity}{' '}
                      {pluralize(line.returnableQuantity, line.uomLabel.toLowerCase())}
                    </span>
                  </div>

                  {quantity > 0 ? (
                    <div className="mt-2">
                      <label
                        htmlFor={`disposition-${line.saleItemId}`}
                        className="block text-xs font-semibold text-ink-muted"
                      >
                        Where does it go?
                      </label>
                      <select
                        id={`disposition-${line.saleItemId}`}
                        value={chosen?.disposition ?? 'RESTOCK_TRUCK'}
                        onChange={(event) => setDisposition(line.saleItemId, event.target.value)}
                        className="mt-1 h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-2.5 text-sm font-medium"
                      >
                        {DISPOSITIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {selected.length > 0 ? (
        <>
          <Card className="space-y-3 p-4">
            <Field label="What happens to the money?" htmlFor="financial-action">
              <Select
                id="financial-action"
                name="financialAction"
                value={financialAction}
                onChange={(event) => setFinancialAction(event.target.value)}
              >
                <option value="APPLY_TO_BALANCE">Credit it against what they owe</option>
                <option value="ACCOUNT_CREDIT">Leave it as credit on the account</option>
                {canRefund ? <option value="REFUND">Refund it</option> : null}
                <option value="NONE">No credit — goods back only</option>
              </Select>
            </Field>

            {financialAction === 'REFUND' ? (
              <>
                <Field label="How are they being paid back?" htmlFor="refund-method">
                  <Select id="refund-method" name="refundMethod" defaultValue="CASH">
                    <option value="CASH">Cash</option>
                    <option value="CHECK">Check</option>
                    <option value="CARD">Card</option>
                    <option value="ACH">ACH</option>
                    <option value="OTHER">Other</option>
                  </Select>
                </Field>
                <Field label="Reference" htmlFor="refund-reference">
                  <Input id="refund-reference" name="refundReference" />
                </Field>
              </>
            ) : null}

            <Field label="Notes (optional)" htmlFor="return-notes">
              <Input id="return-notes" name="notes" placeholder="Anything worth remembering" />
            </Field>
          </Card>

          <div className="above-nav fixed inset-x-0 z-40 border-t border-line bg-surface-raised p-3 shadow-[0_-4px_16px_rgba(15,23,42,0.08)] md:relative md:bottom-auto md:rounded-card md:border md:shadow-none">
            <div className="mx-auto max-w-2xl space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-ink-muted">Roughly</span>
                <span className="tnum text-xl font-extrabold text-ink">
                  {money(estimate.toFixed(2), currency)}
                </span>
              </div>
              <p className="text-[11px] text-ink-subtle">
                The exact credit, including tax, is worked out from the original invoice.
              </p>
              <SubmitButton disabled={selected.length === 0} />
            </div>
          </div>
        </>
      ) : null}
    </form>
  )
}

function money(value: string | number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(value))
}
