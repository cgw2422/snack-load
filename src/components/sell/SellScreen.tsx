'use client'

import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'
import { useOffline } from 'next/offline'
import { useRouter } from 'next/navigation'
import { AlertCircle, Check, CloudOff, Minus, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import { Pill } from '@/components/ui/Pill'
import { ProductPicker } from '@/components/stock/ProductPicker'
import { SignaturePad } from './SignaturePad'
import { checkoutAction, priceCartAction, type SellState } from '@/app/(app)/sell/actions'
import type { PricedCart } from '@/server/services/sale.service'
import type { ProductHit, ProductUomOption } from '@/components/stock/types'
import { useOwner } from '@/components/offline/OfflineRuntime'
import { ageLabel } from '@/lib/offline/age'
import { estimateCart, type Estimate } from '@/lib/offline/estimate'
import { enqueue } from '@/lib/offline/queue'
import { BALANCES, CATALOG, recall, type Stored } from '@/lib/offline/snapshots'
import type { BalanceSnapshot, CatalogSnapshot } from '@/lib/offline/types'

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

function CheckoutButton({
  total,
  label,
  disabled,
}: {
  total: string
  /** Offline the button does not say "checkout": nothing is being charged yet. */
  label?: string
  disabled: boolean
}) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="cash" size="lg" block disabled={pending || disabled}>
      {pending ? 'Saving…' : `${label ?? 'Checkout'} · ${total}`}
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
  customer: {
    id: string
    name: string
    balance: string
    termsCode: string
    /** For the offline estimate only. The posted sale is priced server-side. */
    taxExempt: boolean
    taxRate: string
  }
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

  const offline = useOffline()
  const owner = useOwner()

  const [lines, setLines] = useState<CartLine[]>(initialLines ?? [])
  const [catalog, setCatalog] = useState<Stored<CatalogSnapshot> | null>(null)
  const [balances, setBalances] = useState<Stored<BalanceSnapshot> | null>(null)
  const [priced, setPriced] = useState<PricedCart | null>(null)
  const [pricedError, setPricedError] = useState<string | null>(null)
  const [method, setMethod] = useState('CASH')
  const [tendered, setTendered] = useState('')
  const [signature, setSignature] = useState<string | null>(null)
  const [pricing, startPricing] = useTransition()
  const router = useRouter()

  /**
   * What the screen shows when the server cannot be asked.
   *
   * Only computed while offline. The estimate is deliberately not used as a
   * fallback when a *price* request merely fails online — that would hide a
   * real pricing error behind a plausible number.
   */
  const estimate: Estimate | null =
    offline && catalog
      ? estimateCart({
          lines: lines.map((l) => ({
            productId: l.productId,
            productUomId: l.productUomId,
            quantity: l.quantity,
          })),
          catalog: catalog.value,
          balances: balances?.value ?? null,
          taxRate: customer.taxRate,
          taxExempt: customer.taxExempt,
        })
      : null

  const [state, action] = useActionState(
    async (previous: SellState, formData: FormData) => {
      idempotencyKey.current ??= crypto.randomUUID()
      formData.set('idempotencyKey', idempotencyKey.current)

      // No signal: the sale goes into this phone's queue instead, carrying
      // intent and the estimate the runner was shown — never a price
      // (docs/05 §3). It is posted, numbered and charged when it lands.
      if (offline && owner) {
        const queued = await queueSale({
          owner,
          formData,
          idempotencyKey: idempotencyKey.current,
          customerName: customer.name,
          estimate: estimate?.total,
        })
        // A new cart needs a new key; reusing this one would make the next sale
        // replay as this one (docs/02 §I1). Cleared here rather than in an
        // effect so the screen cannot render the queued sale's cart again.
        idempotencyKey.current = null
        if (queued.queued) {
          setLines([])
          setPriced(null)
          setTendered('')
          setSignature(null)
        }
        return queued
      }

      return checkoutAction(previous, formData)
    },
    EMPTY,
  )

  // Kept ready before it is needed: a runner who loses signal mid-cart cannot
  // fetch the catalogue to price what is already in front of them.
  useEffect(() => {
    let cancelled = false
    void Promise.all([recall<CatalogSnapshot>(CATALOG), recall<BalanceSnapshot>(BALANCES)]).then(
      ([held, stock]) => {
        if (cancelled) return
        setCatalog(held ?? null)
        setBalances(stock ?? null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  // Re-price on the server whenever the cart changes. Debounced so a held
  // stepper does not fire a request per tap.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    clearTimeout(timer.current)
    if (lines.length === 0) return
    // With no signal the framework would hold this request open and retry it on
    // reconnect. The runner needs a number now, so the cached estimate answers
    // instead and the server prices the sale when it lands.
    if (offline) return

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
  }, [lines, customer.id, offline])

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
  const served = lines.length === 0 ? null : priced

  const cart = estimate ?? served
  const estimated = cart !== null && cart === estimate
  const priceError = lines.length === 0 || offline ? null : pricedError

  const total = cart?.total ?? '0.00'
  // The ledger will refuse a line the truck cannot cover, so say so here rather
  // than letting the runner find out after they have taken the money.
  //
  // Offline this is advisory: `available` is as old as the cached balance
  // snapshot, so it warns but does not block — the server is the one that
  // refuses, on arrival.
  const short = estimated ? [] : (cart?.lines.filter((l) => l.baseQuantity > l.available) ?? [])
  const shortOnCachedStock = estimated
    ? (cart?.lines.filter((l) => l.baseQuantity > l.available) ?? [])
    : []
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
          className={
            state.queued
              ? 'flex items-start gap-2.5 rounded-xl border border-alert-500/30 bg-alert-500/10 px-3.5 py-3 text-sm text-alert-600 dark:text-alert-400'
              : 'flex items-start gap-2.5 rounded-xl border border-cash-500/30 bg-cash-50 px-3.5 py-3 text-sm text-cash-700 dark:bg-cash-700/15 dark:text-cash-100'
          }
        >
          {state.queued ? (
            <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : (
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          )}
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
            {estimated && catalog ? (
              <p className="mt-1 text-xs font-semibold text-alert-600 dark:text-alert-400">
                Estimated from prices {ageLabel(catalog)}. The office prices it when it sends.
              </p>
            ) : null}
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
        offlineFallback
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
                        {/* An estimate is a list price, not a negotiated one.
                            Calling it special would be a claim this device has
                            no way to make. */}
                        {priced && !estimated && priced.priceSource !== 'STANDARD'
                          ? ' · special price'
                          : ''}
                        {priced && estimated ? ' · list price' : ''}
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
                  <dt className="text-base font-bold text-ink">
                    {estimated ? 'Estimated total' : 'Total'}
                  </dt>
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

              {shortOnCachedStock.length > 0 ? (
                <p className="flex items-start gap-1.5 text-xs font-semibold text-alert-600">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span>
                    By the last count{balances ? ` (${ageLabel(balances)})` : ''} the truck is short
                    on {shortOnCachedStock.map((l) => l.productName).join(', ')}. The office will
                    refuse the line if that is still true when this sends.
                  </span>
                </p>
              ) : null}

              {estimated && cart.unknown.length > 0 ? (
                <p className="flex items-start gap-1.5 text-xs font-semibold text-stop-600">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span>
                    This phone has no cached price for{' '}
                    {cart.unknown.join(', ')}, so it cannot show you a total. Take the order on
                    paper, or wait for a signal.
                  </span>
                </p>
              ) : null}

              <CheckoutButton
                total={money(total, currency)}
                label={estimated ? 'Save on this phone' : undefined}
                disabled={
                  !cart ||
                  (!offline && pricing) ||
                  lines.length === 0 ||
                  short.length > 0 ||
                  (estimated && cart.unknown.length > 0)
                }
              />
            </div>
          </div>
        </>
      ) : null}
    </form>
  )
}

/**
 * Writing the sale to this phone instead of to the server (docs/05 §3).
 *
 * The payload is exactly what the live Server Action would have sent, minus
 * anything computed: the same `cart` JSON the form already carries, the same
 * stable idempotency key, the tendered amount as a fact about cash that changed
 * hands rather than as a price. `/api/v1/sales` validates it with the same
 * schema and runs the same `checkout`, so a queued sale cannot take a different
 * path from one taken with a signal.
 *
 * A failure to *queue* is reported as a failure. There is nowhere else to put
 * the sale, and a runner who is told it is safe when it is not will find out at
 * the end of the day.
 */
async function queueSale(args: {
  owner: string
  formData: FormData
  idempotencyKey: string
  customerName: string
  estimate?: string
}): Promise<SellState> {
  const { formData } = args

  try {
    const cart = JSON.parse(String(formData.get('cart') ?? '{}')) as Record<string, unknown>
    const method = String(formData.get('method') ?? 'NONE')
    const tendered = String(formData.get('amount') ?? '').trim()
    const signatureData = String(formData.get('signatureData') ?? '')

    const lines = Array.isArray(cart.lines) ? cart.lines : []
    if (lines.length === 0) return { error: 'Add at least one product.' }

    await enqueue({
      id: args.idempotencyKey,
      owner: args.owner,
      kind: 'sale',
      endpoint: '/api/v1/sales',
      label: `${args.customerName} · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`,
      clientEstimate: args.estimate,
      payload: {
        ...cart,
        idempotencyKey: args.idempotencyKey,
        notes: formData.get('notes') || undefined,
        payment:
          method === 'NONE' || !tendered || Number(tendered) <= 0
            ? null
            : {
                method,
                // What the runner physically took. Not a price, and not a
                // total — the server decides that on arrival.
                amount: tendered,
                checkNumber: formData.get('checkNumber') || undefined,
                referenceNumber: formData.get('referenceNumber') || undefined,
              },
        signature: signatureData
          ? { signerName: formData.get('signerName') || undefined, imageDataUrl: signatureData }
          : null,
      },
    })

    return {
      queued: true,
      message:
        'Saved on this phone. It is not posted yet — it sends itself, and the tray will tell you when it lands.',
    }
  } catch {
    return {
      error:
        'This phone could not save the sale. Do not take the money on it — write the order down.',
    }
  }
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
