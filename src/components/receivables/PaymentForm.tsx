'use client'

import { useActionState, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { useRouter } from 'next/navigation'
import { AlertCircle, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import { recordPaymentAction, type SellState } from '@/app/(app)/sell/actions'

const EMPTY: SellState = {}

const METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CHECK', label: 'Check' },
  { value: 'CARD', label: 'Card' },
  { value: 'ACH', label: 'ACH' },
  { value: 'OTHER', label: 'Other' },
]

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="cash" size="lg" block disabled={pending}>
      {pending ? 'Recording…' : label}
    </Button>
  )
}

/**
 * Taking money at the counter (spec §26).
 *
 * The idempotency key is minted when the form mounts, not when it submits, so
 * a runner who taps twice on a bad connection records one payment. Allocation
 * is oldest-first and happens on the server — the client never decides which
 * invoice a dollar lands on (docs/02 §A3).
 */
export function PaymentForm({
  customerId,
  balance,
  currency,
}: {
  customerId: string
  balance: string
  currency: string
}) {
  const [method, setMethod] = useState('CASH')
  const [amount, setAmount] = useState(balance)
  const router = useRouter()

  // Minted at submit, never during render: a key generated while rendering
  // differs between the server pass and the client pass and tears hydration.
  // It survives a failed attempt, so a retry replays instead of paying twice,
  // and is retired once a payment lands so the next one is a new payment.
  const key = useRef<string | null>(null)

  const [state, action] = useActionState(
    async (previous: SellState, formData: FormData) => {
      key.current ??= crypto.randomUUID()
      formData.set('idempotencyKey', key.current)

      const result = await recordPaymentAction(previous, formData)
      if (!result.error) {
        key.current = null
        setAmount('')
        router.refresh()
      }
      return result
    },
    EMPTY,
  )

  const over = Number(amount) > Number(balance) + 0.004

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-bold text-ink">Take a payment</h2>

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

      <form action={action} className="space-y-3">
        <input type="hidden" name="customerId" value={customerId} />

        <Field label="How are they paying?" htmlFor="payment-method">
          <Select
            id="payment-method"
            name="method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Amount"
          htmlFor="payment-amount"
          hint={over ? 'More than they owe — the extra stays as credit on the account.' : undefined}
        >
          <Input
            id="payment-amount"
            name="amount"
            inputMode="decimal"
            required
            value={amount}
            placeholder={balance}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </Field>

        {method === 'CHECK' ? (
          <Field label="Check number" htmlFor="payment-check">
            <Input id="payment-check" name="checkNumber" inputMode="numeric" />
          </Field>
        ) : null}

        {method === 'CARD' || method === 'ACH' || method === 'OTHER' ? (
          <Field label="Reference" htmlFor="payment-reference">
            <Input id="payment-reference" name="referenceNumber" />
          </Field>
        ) : null}

        <SubmitButton
          label={`Record ${new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency,
            minimumFractionDigits: 2,
          }).format(Number(amount) || 0)}`}
        />
      </form>
    </Card>
  )
}
