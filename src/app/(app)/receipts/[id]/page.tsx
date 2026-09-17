import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { getReceiptDocument } from '@/server/documents/receiptDocument'
import { listDeliveries } from '@/server/services/delivery.service'
import { isAppError } from '@/lib/errors'
import { ReceiptPaper } from '@/components/receipts/ReceiptPaper'
import { ReceiptActions } from '@/components/receipts/ReceiptActions'
import { DeliveryHistory } from '@/components/receipts/DeliveryHistory'
import { ButtonLink } from '@/components/ui/Button'

export const metadata: Metadata = { title: 'Receipt' }

export default async function ReceiptPage(props: PageProps<'/receipts/[id]'>) {
  const { id } = await props.params
  const ctx = await requireAuth()

  const doc = await getReceiptDocument(ctx, id).catch((error: unknown) => {
    // getReceiptDocument raises NOT_FOUND both for a missing sale and for one
    // belonging to another runner — a 404 is the honest answer to both.
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound()
    throw error
  })

  const canSend = can(ctx, 'receipt:send')
  const deliveries = await listDeliveries(ctx, { kind: 'sale', id: doc.saleId })

  const total = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: doc.currency,
    minimumFractionDigits: 2,
  }).format(Number(doc.total))

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6 print:max-w-none print:p-0 print:pb-0">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Link
          href="/receipts"
          className="inline-flex min-h-touch items-center gap-1 text-sm font-semibold text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Receipts
        </Link>
        <span className="flex items-center gap-2">
          {can(ctx, 'return:create') && doc.status !== 'VOIDED' ? (
            <ButtonLink href={`/receipts/${doc.saleId}/return`} size="sm" variant="secondary">
              Return items
            </ButtonLink>
          ) : null}
          <ButtonLink
            href={`/customers/${doc.customerId}/account`}
            size="sm"
            variant="secondary"
          >
            {doc.billTo.name}
          </ButtonLink>
        </span>
      </div>

      <ReceiptPaper doc={doc} />

      <ReceiptActions
        saleId={doc.saleId}
        receiptNumber={doc.receiptNumber}
        customerName={doc.billTo.name}
        customerEmail={doc.billTo.email}
        customerPhone={doc.billTo.phone}
        total={total}
        canVoid={can(ctx, 'sale:void')}
        canSend={canSend}
        voided={doc.status === 'VOIDED'}
      />

      {deliveries.length > 0 ? (
        <DeliveryHistory rows={deliveries} timeZone={doc.timeZone} />
      ) : null}

      {Number(doc.balanceDue) > 0 &&
      doc.status !== 'VOIDED' &&
      (can(ctx, 'payment:create') || can(ctx, 'payment:read')) ? (
        <div className="print:hidden">
          <ButtonLink
            href={`/receivables?customerId=${doc.customerId}`}
            variant="cash"
            size="lg"
            block
          >
            Take a payment
          </ButtonLink>
        </div>
      ) : null}
    </div>
  )
}
