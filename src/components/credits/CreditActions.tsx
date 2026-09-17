'use client'

import { useActionState, useRef, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Banknote, Check, Copy, Download, Link2, Mail, MessageSquare, Printer } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import {
  applyCreditAction,
  creditShareLinkAction,
  emailCreditAction,
  refundCreditAction,
  textCreditAction,
  type CreditState,
} from '@/app/(app)/credits/actions'

const EMPTY: CreditState = {}

const METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CHECK', label: 'Check' },
  { value: 'CARD', label: 'Card' },
  { value: 'ACH', label: 'ACH' },
  { value: 'OTHER', label: 'Other' },
]

function SubmitButton({ idle, busy, variant = 'primary' }: { idle: string; busy: string; variant?: 'primary' | 'cash' }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant={variant} size="lg" block disabled={pending}>
      {pending ? busy : idle}
    </Button>
  )
}

type Panel = 'none' | 'email' | 'text' | 'refund'

/**
 * What can be done with a credit memo once it exists (spec §6, §10).
 *
 * Applying, refunding and sending are three different grants, so the buttons
 * that appear depend on what the person is actually allowed to do — a runner
 * who can issue a credit at the counter does not get a Refund button.
 */
export function CreditActions({
  creditMemoId,
  number,
  customerName,
  customerEmail,
  customerPhone,
  total,
  remaining,
  currency,
  canSend,
  canApply,
  canRefund,
  voided,
}: {
  creditMemoId: string
  number: string
  customerName: string
  customerEmail: string | null
  customerPhone: string | null
  total: string
  remaining: string
  currency: string
  canSend: boolean
  canApply: boolean
  canRefund: boolean
  voided: boolean
}) {
  const [applyState, applyAction] = useActionState(applyCreditAction, EMPTY)
  const [emailState, emailAction] = useActionState(emailCreditAction, EMPTY)
  const [textState, textAction] = useActionState(textCreditAction, EMPTY)

  const refundKey = useRef<string | null>(null)
  const [refundState, refundAction] = useActionState(
    async (previous: CreditState, formData: FormData) => {
      // Minted at submit, outside render, and kept across a retry: a repeated
      // tap must not hand over the money twice.
      refundKey.current ??= crypto.randomUUID()
      formData.set('idempotencyKey', refundKey.current)
      const result = await refundCreditAction(previous, formData)
      if (!result.error) refundKey.current = null
      return result
    },
    EMPTY,
  )

  const [panel, setPanel] = useState<Panel>('none')
  const [linkNotice, setLinkNotice] = useState<string | null>(null)
  const [linking, startLinking] = useTransition()

  const notice =
    linkNotice ?? applyState.message ?? refundState.message ?? emailState.message ?? textState.message
  const error =
    applyState.error ?? refundState.error ?? emailState.error ?? textState.error
  const hasCredit = Number(remaining) > 0 && !voided

  function copyLink() {
    setLinkNotice(null)
    startLinking(async () => {
      const result = await creditShareLinkAction(creditMemoId)
      if (result.error || !result.url) {
        setLinkNotice(result.error ?? 'That link could not be created.')
        return
      }
      try {
        await navigator.clipboard.writeText(result.url)
        setLinkNotice('Link copied.')
      } catch {
        setLinkNotice(`Copy this link: ${result.url}`)
      }
    })
  }

  return (
    <div className="space-y-3 print:hidden">
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {notice ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-cash-500/30 bg-cash-50 px-3.5 py-3 text-sm text-cash-700 dark:bg-cash-700/15 dark:text-cash-100"
        >
          <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      ) : null}

      {hasCredit ? (
        <Card className="flex flex-wrap items-baseline justify-between gap-2 p-4">
          <span className="text-sm font-semibold text-ink-muted">Credit still available</span>
          <span className="tnum text-xl font-extrabold text-cash-700">
            {new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency,
              minimumFractionDigits: 2,
            }).format(Number(remaining))}
          </span>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Button type="button" variant="secondary" size="lg" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden="true" />
          Print
        </Button>

        <a
          href={`/api/v1/credits/${creditMemoId}/pdf`}
          className="inline-flex h-14 items-center justify-center gap-2.5 rounded-xl border border-line-strong bg-surface-raised px-6 text-base font-semibold text-ink transition-colors hover:bg-surface-sunken"
        >
          <Download className="size-4" aria-hidden="true" />
          PDF
        </a>

        {canSend ? (
          <>
            <Button type="button" variant="secondary" size="lg" disabled={linking} onClick={copyLink}>
              <Copy className="size-4" aria-hidden="true" />
              Copy link
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={() => setPanel(panel === 'email' ? 'none' : 'email')}
            >
              <Mail className="size-4" aria-hidden="true" />
              Email
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={() => setPanel(panel === 'text' ? 'none' : 'text')}
            >
              <MessageSquare className="size-4" aria-hidden="true" />
              Text
            </Button>
          </>
        ) : null}

        {canRefund && hasCredit ? (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => setPanel(panel === 'refund' ? 'none' : 'refund')}
          >
            <Banknote className="size-4" aria-hidden="true" />
            Refund
          </Button>
        ) : null}
      </div>

      {canApply && hasCredit ? (
        <form action={applyAction}>
          <input type="hidden" name="creditMemoId" value={creditMemoId} />
          <SubmitButton idle="Apply to open invoices" busy="Applying…" variant="cash" />
        </form>
      ) : null}

      {panel === 'refund' ? (
        <Card className="p-4">
          <form action={refundAction} className="space-y-3">
            <input type="hidden" name="creditMemoId" value={creditMemoId} />
            <Field label="How is it being refunded?" htmlFor="refund-method">
              <Select id="refund-method" name="method" defaultValue="CASH">
                {METHODS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Amount"
              htmlFor="refund-amount"
              hint={`${number} has ${remaining} left.`}
            >
              <Input
                id="refund-amount"
                name="amount"
                inputMode="decimal"
                required
                defaultValue={remaining}
              />
            </Field>
            <Field
              label="Reference"
              htmlFor="refund-reference"
              hint="Cheque number, card authorisation, ACH trace — whatever proves it left."
            >
              <Input id="refund-reference" name="referenceNumber" />
            </Field>
            <SubmitButton idle="Record the refund" busy="Recording…" />
          </form>
        </Card>
      ) : null}

      {panel === 'email' ? (
        <Card className="p-4">
          <form action={emailAction} className="space-y-3">
            <input type="hidden" name="creditMemoId" value={creditMemoId} />
            <Field
              label="Send to"
              htmlFor="credit-email-to"
              hint={
                customerEmail
                  ? `${customerName}'s address on file.`
                  : `${customerName} has no address on file.`
              }
            >
              <Input
                id="credit-email-to"
                name="to"
                type="email"
                required
                defaultValue={customerEmail ?? ''}
              />
            </Field>
            <Field label="Add a note (optional)" htmlFor="credit-email-message">
              <Input id="credit-email-message" name="message" />
            </Field>
            <SubmitButton idle={`Send ${number}`} busy="Sending…" />
          </form>
        </Card>
      ) : null}

      {panel === 'text' ? (
        <Card className="p-4">
          <form action={textAction} className="space-y-3">
            <input type="hidden" name="creditMemoId" value={creditMemoId} />
            <Field label="Text to" htmlFor="credit-text-to" hint="They get a link to this credit.">
              <Input
                id="credit-text-to"
                name="to"
                type="tel"
                required
                defaultValue={customerPhone ?? ''}
              />
            </Field>
            <SubmitButton idle="Send the link" busy="Sending…" />
          </form>
        </Card>
      ) : null}

      <p className="flex items-center gap-1.5 px-1 text-xs text-ink-subtle">
        <Link2 className="size-3" aria-hidden="true" />
        {number} · {total} issued
      </p>
    </div>
  )
}
