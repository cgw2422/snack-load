'use client'

import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'
import { useRouter } from 'next/navigation'
import { AlertCircle, Check, Minus, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import { Pill } from '@/components/ui/Pill'
import { ProductPicker } from '@/components/stock/ProductPicker'
import { SignaturePad } from './SignaturePad'
import { checkoutAction, priceCartAction, type SellState } from '@/app/(app)/sell/actions'
import type { PricedCart } from '@/server/services/sale.service'
import type { ProductHit, ProductUomOption } from '@/components/stock/types'

const EMPTY: SellState = {}

export type CartLine = {
  productId: string
  productUomId: string
  quantity: number
  name: string
  uoms: ProductUomOption[]
}

const TENDERS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CHECK', label: 'Check' },
  { value: 'CARD', label: 'Card' },
  { value: 'ACH', label: 'ACH' },
  { value: 'NONE', label: 'On account' },
]

function CheckoutButton({ total, disabled }: { total: string; disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="cash" size="lg" block disabled={pending || disabled}>
      {pending ? 'Saving…' : `Checkout · ${total}`}
    </Button>
  )
}

/**
 * The sell screen (spec §22).
 *
 * The client holds intent only — which product, which unit, how many. Every
 * price, tax figure and total comes back from the server, so what the runner
 * sees is exactly what will be charged, and a crafted request cannot invent a
 * price. The idempotency key is minted when the cart opens, so a retry in a
 * dead-zone store replays rather than billing twice.
 */
export function SellScreen({
  customer,
  routeStopId,
  currency,
  sellingLocation,
  initialLines,
}: {
  customer: { id: string; name: string; balance: string; termsCode: string }
  routeStopId?: string
  currency: string
  /** Where stock will come off. Resolved on the server; the client only shows it. */
  sellingLocation: { id: string; name: string }
  /** Pre-filled from an earlier order when the runner tapped "Repeat". */
  initialLines?: CartLine[]
}) {
  // Minted once, outside render, and reused for every retry of this cart: a
  // runner who taps twice in a dead-zone store replays rather than paying
  // twice (docs/02 §I1). It is deliberately never read during render.
  const idempotencyKey = useRef<string | null>(null)

  const [state, action] = useActionState(
    async (previous: SellState, formData: FormData) => {
      idempotencyKey.current ??= crypto.randomUUID()
      formData.set('idempotencyKey', idempotencyKey.current)
      return checkoutAction(previous, formData)
    },
    EMPTY,
  )
  const [lines, setLines] = useState<CartLine[]>(initialLines ?? [])
  const [priced, setPriced] = useState<PricedCart | null>(null)
  const [pricedError, setPricedError] = useState<string | null>(null)
  const [method, setMethod] = useState('CASH')
  const [tendered, setTendered] = useState('')
  const [signature, setSignature] = useState<string | null>(null)
  const [pricing, startPricing] = useTransition()
  const router = useRouter()

  // Re-price on the server whenever the cart changes. Debounced so a held
  // stepper does not fire a request per tap.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    clearTimeout(timer.current)
    if (lines.length === 0) return

    timer.current = setTimeout(() => {
      startPricing(async () => {
        const result = await priceCartAction({
          customerId: customer.id,
          lines: lines.map((l) => ({
            productId: l.productId,
            productUomId: l.productUomId,
            quantity: l.quantity,
          })),
        })
        setPricedError(result.error ?? null)
        if (result.cart) setPriced(result.cart)
      })
    }, 150)

    return () => clearTimeout(timer.current)
  }, [lines, customer.id])

  // A completed sale goes straight to its receipt — that is what the store wants.
  useEffect(() => {
    if (state.saleId) router.push(`/receipts/${state.saleId}`)
  }, [state.saleId, router])

  const addProduct = useCallback((product: ProductHit, uoms: ProductUomOption[]) => {
    const usable =
      uoms.length > 0
        ? uoms
        : [{ id: 'base', code: 'EACH', label: product.baseUomLabel, baseUnitsPerUom: 1, price: product.unitPrice, isDefaultSaleUom: true }]
    const preferred = usable.find((u) => u.isDefaultSaleUom) ?? usable[usable.length - 1]

    setLines((current) => {
      const existing = current.findIndex((l) => l.productId === product.id)
      // Scanning the same item twice means two of it, not an error.
      if (existing >= 0) {
        const next = [...current]
        next[existing] = { ...next[existing], quantity: next[existing].quantity + 1 }
        return next
      }
      return [
        ...current,
        {
          productId: product.id,
          productUomId: preferred.id,
          quantity: 1,
          name: product.name,
          uoms: usable,
        },
      ]
    })
  }, [])

  function patch(productId: string, changes: Partial<CartLine>) {
    setLines((current) =>
      current.map((l) => (l.productId === productId ? { ...l, ...changes } : l)),
    )
  }

  function remove(productId: string) {
    setLines((current) => current.filter((l) => l.productId !== productId))
  }

  // An empty cart is worth nothing; no effect has to remember to say so.
  const cart = lines.length === 0 ? null : priced
  const priceError = lines.length === 0 ? null : pricedError

  const total = cart?.total ?? '0.00'
  // The ledger will refuse a line the truck cannot cover, so say so here rather
  // than letting the runner find out after they have taken the money.
  const short = cart?.lines.filter((l) => l.baseQuantity > l.available) ?? []
  const change =
    method !== 'NONE' && tendered && cart
      ? Number(tendered) - Number(cart.total)
      : null

  const payload = {
    customerId: customer.id,
    routeStopId: routeStopId ?? '',
    lines: lines.map((l) => ({
      productId: l.productId,
      productUomId: l.productUomId,
      quantity: l.quantity,
    })),
  }

  return (
    <form action={action} className="space-y-4 pb-64 md:pb-4">
      <input type="hidden" name="cart" value={JSON.stringify(payload)} />
      <input type="hidden" name="signatureData" value={signature ?? ''} />

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
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-extrabold text-ink">{customer.name}</h1>
            <p className="text-xs text-ink-muted">
              Selling from {cart?.sellingLocationName ?? sellingLocation.name} ·{' '}
              {customer.termsCode}
            </p>
          </div>
          {Number(customer.balance) > 0 ? (
            <Pill tone="alert">Owes {money(customer.balance, currency)}</Pill>
          ) : (
            <Pill tone="cash">Paid up</Pill>
          )}
        </div>
      </Card>

      <ProductPicker
        locationId={cart?.sellingLocationId ?? sellingLocation.id}
        onPick={addProduct}
        placeholder="Search or scan a product"
      />

      {priceError ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{priceError}</span>
        </div>
      ) : null}

      <Card aria-busy={pricing}>
        {lines.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-muted">
            Nothing in the cart yet. Search above, or scan a barcode.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {lines.map((line) => {
              const priced = cart?.lines.find((l) => l.productId === line.productId)
              const short = priced ? priced.baseQuantity > priced.available : false

              return (
                <li key={line.productId} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{line.name}</p>
                      <p className="text-xs text-ink-muted">
                        {priced ? `${money(priced.unitPrice, currency)} / ${priced.uomLabel.toLowerCase()}` : '…'}
                        {priced && priced.priceSource !== 'STANDARD' ? ' · special price' : ''}
                      </p>
                      {short ? (
                        <p className="flex items-center gap-1 text-xs font-semibold text-alert-600">
                          <TriangleAlert className="size-3" aria-hidden="true" />
                          Only {priced!.available} on the truck
                        </p>
                      ) : null}
                    </div>

                    <span className="tnum shrink-0 text-base font-bold text-ink">
                      {priced ? money(priced.lineTotal, currency) : '—'}
                    </span>

                    <button
                      type="button"
                      aria-label={`Remove ${line.name}`}
                      onClick={() => remove(line.productId)}
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-subtle hover:bg-stop-500/5 hover:text-stop-600"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      aria-label={`One fewer ${line.name}`}
                      onClick={() => patch(line.productId, { quantity: Math.max(1, line.quantity - 1) })}
                      className="flex size-11 items-center justify-center rounded-lg border border-line-strong bg-surface-raised active:bg-surface-sunken"
                    >
                      <Minus className="size-4" aria-hidden="true" />
                    </button>

                    <input
                      type="text"
                      inputMode="numeric"
                      value={line.quantity}
                      aria-label={`${line.name} quantity`}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) =>
                        patch(line.productId, {
                          quantity: Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1),
                        })
                      }
                      className="tnum h-11 w-14 rounded-lg border border-line-strong bg-surface-raised text-center text-base font-bold"
                    />

                    <button
                      type="button"
                      aria-label={`One more ${line.name}`}
                      onClick={() => patch(line.productId, { quantity: line.quantity + 1 })}
                      className="flex size-11 items-center justify-center rounded-lg border border-line-strong bg-surface-raised active:bg-surface-sunken"
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </button>

                    <select
                      value={line.productUomId}
                      aria-label={`Unit for ${line.name}`}
                      onChange={(e) => patch(line.productId, { productUomId: e.target.value })}
                      className="h-11 rounded-lg border border-line-strong bg-surface-raised px-2.5 text-sm font-medium"
                    >
                      {line.uoms.map((uom) => (
                        <option key={uom.id} value={uom.id}>
                          {uom.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {lines.length > 0 ? (
        <>
          <Card className="space-y-3 p-4">
            <Field label="How are they paying?" htmlFor="method">
              <Select
                id="method"
                name="method"
                value={method}
                onChange={(e) => {
                  setMethod(e.target.value)
                  if (e.target.value === 'NONE') setTendered('')
                }}
              >
                {TENDERS.map((tender) => (
                  <option key={tender.value} value={tender.value}>
                    {tender.label}
                  </option>
                ))}
              </Select>
            </Field>

            {method !== 'NONE' ? (
              <>
                <Field label="Amount taken" htmlFor="amount">
                  <Input
                    id="amount"
                    name="amount"
                    inputMode="decimal"
                    value={tendered}
                    placeholder={total}
                    onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ''))}
                  />
                </Field>

                {method === 'CHECK' ? (
                  <Field label="Check number" htmlFor="checkNumber">
                    <Input id="checkNumber" name="checkNumber" inputMode="numeric" />
                  </Field>
                ) : null}

                {change !== null && change > 0.004 ? (
                  <p className="tnum rounded-xl bg-cash-50 px-3.5 py-2.5 text-sm font-semibold text-cash-700 dark:bg-cash-700/15 dark:text-cash-100">
                    Change due {money(change.toFixed(2), currency)}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-ink-muted">
                The whole {money(total, currency)} goes on the account.
              </p>
            )}

            <SignaturePad onChange={setSignature} />
            {signature ? (
              <Field label="Signed by" htmlFor="signerName">
                <Input id="signerName" name="signerName" placeholder="Name" />
              </Field>
            ) : null}
          </Card>

          <div className="above-nav fixed inset-x-0 z-40 border-t border-line bg-surface-raised p-3 shadow-[0_-4px_16px_rgba(15,23,42,0.08)] md:relative md:bottom-auto md:rounded-card md:border md:shadow-none">
            <div className="mx-auto max-w-2xl space-y-2">
              <dl className="space-y-0.5 text-sm">
                <Row label="Subtotal" value={money(cart?.subtotal ?? '0.00', currency)} />
                {Number(cart?.discountTotal ?? 0) > 0 ? (
                  <Row label="Discount" value={`−${money(cart!.discountTotal, currency)}`} />
                ) : null}
                <Row
                  label={cart?.taxExempt ? 'Tax (exempt)' : 'Tax'}
                  value={money(cart?.taxTotal ?? '0.00', currency)}
                />
                <div className="flex items-baseline justify-between border-t border-line pt-1.5">
                  <dt className="text-base font-bold text-ink">Total</dt>
                  <dd className="tnum text-xl font-extrabold text-ink">
                    {money(total, currency)}
                  </dd>
                </div>
              </dl>

              {short.length > 0 ? (
                <p className="flex items-start gap-1.5 text-xs font-semibold text-alert-600">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span>
                    Not enough on the truck for{' '}
                    {short.map((l) => l.productName).join(', ')}. Lower the quantity or load more.
                  </span>
                </p>
              ) : null}

              <CheckoutButton
                total={money(total, currency)}
                disabled={!cart || pricing || lines.length === 0 || short.length > 0}
              />
            </div>
          </div>
        </>
      ) : null}
    </form>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tnum font-semibold text-ink">{value}</dd>
    </div>
  )
}

function money(value: string | number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(value))
}
