'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Check, Printer, Share2, Ban } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Field'
import { voidSaleAction, type SellState } from '@/app/(app)/sell/actions'

const EMPTY: SellState = {}

function VoidButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="danger" size="lg" block disabled={pending}>
      {pending ? 'Voiding…' : 'Void this sale'}
    </Button>
  )
}

/**
 * What a runner can do with a receipt once it exists (spec §24, §25).
 *
 * Voiding is the only destructive option, and it is not a delete: the service
 * writes a compensating reversal, stock goes back on the truck and money comes
 * back as credit (docs/02 §A4). A reason is required because the audit row is
 * worthless without one.
 */
export function ReceiptActions({
  saleId,
  receiptNumber,
  customerName,
  total,
  canVoid,
  voided,
}: {
  saleId: string
  receiptNumber: string
  customerName: string
  total: string
  canVoid: boolean
  voided: boolean
}) {
  const [state, action] = useActionState(voidSaleAction, EMPTY)
  const [confirming, setConfirming] = useState(false)

  async function share() {
    const url = window.location.href
    const text = `Receipt ${receiptNumber} for ${customerName} — ${total}`

    if (navigator.share) {
      try {
        await navigator.share({ title: receiptNumber, text, url })
        return
      } catch {
        // The runner dismissed the sheet; fall through to the clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`)
    } catch {
      // Nothing more we can do without a clipboard; the link is on screen.
    }
  }

  return (
    <div className="space-y-3 print:hidden">
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

      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="secondary" size="lg" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden="true" />
          Print
        </Button>
        <Button type="button" variant="secondary" size="lg" onClick={share}>
          <Share2 className="size-4" aria-hidden="true" />
          Share
        </Button>
      </div>

      {canVoid && !voided ? (
        confirming ? (
          <Card className="space-y-3 p-4">
            <p className="text-sm text-ink">
              Voiding puts every item back on the truck and clears the balance. The receipt stays
              on file, marked voided — nothing is deleted.
            </p>
            <form action={action} className="space-y-3">
              <input type="hidden" name="saleId" value={saleId} />
              <Field label="Why?" htmlFor="reason">
                <Input
                  id="reason"
                  name="reason"
                  required
                  minLength={3}
                  placeholder="Wrong store, duplicate, damaged goods…"
                />
              </Field>
              <VoidButton />
              <Button
                type="button"
                variant="ghost"
                size="lg"
                block
                onClick={() => setConfirming(false)}
              >
                Keep the sale
              </Button>
            </form>
          </Card>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="lg"
            block
            onClick={() => setConfirming(true)}
          >
            <Ban className="size-4" aria-hidden="true" />
            Void this sale
          </Button>
        )
      ) : null}
    </div>
  )
}
