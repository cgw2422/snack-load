'use client'

import { useActionState, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'
import {
  AlertCircle, Ban, Check, Copy, Download, Mail, MessageSquare, Printer, Share2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Field'
import {
  emailReceiptAction,
  shareLinkAction,
  textReceiptAction,
  voidSaleAction,
  type SellState,
} from '@/app/(app)/sell/actions'

const EMPTY: SellState = {}

function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="primary" size="lg" block disabled={pending}>
      {pending ? busy : idle}
    </Button>
  )
}

function VoidButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="danger" size="lg" block disabled={pending}>
      {pending ? 'Voiding…' : 'Void this sale'}
    </Button>
  )
}

type Panel = 'none' | 'email' | 'text' | 'void'

/**
 * What a runner or office user can do with a receipt once it exists (spec §25).
 *
 * Five ways out of the building — share, copy a link, download the PDF, email,
 * text, print — plus voiding, which is the only destructive one and is not a
 * delete: the service writes a compensating reversal, stock goes back on the
 * truck and money comes back as credit (docs/02 §A4).
 *
 * Native Web Share is used where the browser has it, because on a phone it
 * reaches WhatsApp and Messages and the printer app all at once. Everything
 * else is an explicit button, since Web Share is absent on desktop Firefox, on
 * every desktop Chrome without a share target, and in most in-app browsers.
 */
export function ReceiptActions({
  saleId,
  receiptNumber,
  customerName,
  customerEmail,
  customerPhone,
  total,
  canVoid,
  canSend,
  voided,
}: {
  saleId: string
  receiptNumber: string
  customerName: string
  customerEmail: string | null
  customerPhone: string | null
  total: string
  canVoid: boolean
  canSend: boolean
  voided: boolean
}) {
  const [voidState, voidAction] = useActionState(voidSaleAction, EMPTY)
  const [emailState, emailAction] = useActionState(emailReceiptAction, EMPTY)
  const [textState, textAction] = useActionState(textReceiptAction, EMPTY)

  const [panel, setPanel] = useState<Panel>('none')
  const [linkNotice, setLinkNotice] = useState<string | null>(null)
  const [linking, startLinking] = useTransition()

  const pdfUrl = `/api/v1/receipts/${saleId}/pdf`
  const notice = linkNotice ?? voidState.message ?? emailState.message ?? textState.message
  const error = voidState.error ?? emailState.error ?? textState.error

  /**
   * Minting the link is a server round-trip, and Safari only opens the share
   * sheet from inside the gesture that started it. So the sheet is attempted
   * first with what we have, and the link is fetched before that only when we
   * are going to the clipboard instead.
   */
  function withLink(use: (url: string) => void | Promise<void>) {
    setLinkNotice(null)
    startLinking(async () => {
      const result = await shareLinkAction(saleId)
      if (result.error || !result.url) {
        setLinkNotice(result.error ?? 'That link could not be created.')
        return
      }
      await use(result.url)
    })
  }

  function share() {
    withLink(async (url) => {
      const text = `Receipt ${receiptNumber} for ${customerName} — ${total}`
      if (navigator.share) {
        try {
          await navigator.share({ title: receiptNumber, text, url })
          setLinkNotice('Shared.')
          return
        } catch {
          // The person dismissed the sheet, or the browser refused it. Either
          // way the link is good; fall through to the clipboard.
        }
      }
      await copyToClipboard(`${text}\n${url}`, setLinkNotice)
    })
  }

  function copyLink() {
    withLink(async (url) => {
      await copyToClipboard(url, setLinkNotice)
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

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Button type="button" variant="secondary" size="lg" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden="true" />
          Print
        </Button>

        <a
          href={`${pdfUrl}?layout=full`}
          className="inline-flex h-14 items-center justify-center gap-2.5 rounded-xl border border-line-strong bg-surface-raised px-6 text-base font-semibold text-ink transition-colors hover:bg-surface-sunken"
        >
          <Download className="size-4" aria-hidden="true" />
          PDF
        </a>

        {canSend ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={linking}
              onClick={share}
            >
              <Share2 className="size-4" aria-hidden="true" />
              Share
            </Button>

            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={linking}
              onClick={copyLink}
            >
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
      </div>

      {panel === 'email' ? (
        <Card className="p-4">
          <form action={emailAction} className="space-y-3">
            <input type="hidden" name="saleId" value={saleId} />
            <Field
              label="Send to"
              htmlFor="email-to"
              hint={
                customerEmail
                  ? `${customerName}'s address on file. Change it to send somewhere else.`
                  : `${customerName} has no address on file.`
              }
            >
              <Input
                id="email-to"
                name="to"
                type="email"
                required
                defaultValue={customerEmail ?? ''}
                placeholder="name@store.com"
              />
            </Field>
            <Field label="Add a note (optional)" htmlFor="email-message">
              <Input id="email-message" name="message" placeholder="Thanks for the order!" />
            </Field>
            <SubmitButton idle="Send the receipt" busy="Sending…" />
          </form>
        </Card>
      ) : null}

      {panel === 'text' ? (
        <Card className="p-4">
          <form action={textAction} className="space-y-3">
            <input type="hidden" name="saleId" value={saleId} />
            <Field
              label="Text to"
              htmlFor="text-to"
              hint="They get a link to this receipt, not an attachment."
            >
              <Input
                id="text-to"
                name="to"
                type="tel"
                required
                defaultValue={customerPhone ?? ''}
                placeholder="(555) 123-4567"
              />
            </Field>
            <SubmitButton idle="Send the link" busy="Sending…" />
          </form>
        </Card>
      ) : null}

      {canVoid && !voided ? (
        panel === 'void' ? (
          <Card className="space-y-3 p-4">
            <p className="text-sm text-ink">
              Voiding puts every item back on the truck and clears the balance. The receipt stays
              on file, marked voided — nothing is deleted, and anyone holding a link to it will
              see the void.
            </p>
            <form action={voidAction} className="space-y-3">
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
                onClick={() => setPanel('none')}
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
            onClick={() => setPanel('void')}
          >
            <Ban className="size-4" aria-hidden="true" />
            Void this sale
          </Button>
        )
      ) : null}
    </div>
  )
}

/**
 * The clipboard is blocked in more places than people expect — insecure
 * origins, some in-app browsers, a denied permission — so a failure has to say
 * something useful rather than nothing at all.
 */
async function copyToClipboard(value: string, notify: (message: string) => void) {
  try {
    await navigator.clipboard.writeText(value)
    notify('Link copied.')
  } catch {
    notify(`Copy this link: ${value}`)
  }
}
