import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { getCreditDocument } from '@/server/documents/creditDocument'
import { listDeliveries } from '@/server/services/delivery.service'
import { isAppError } from '@/lib/errors'
import { ReceiptPaper } from '@/components/receipts/ReceiptPaper'
import { CreditActions } from '@/components/credits/CreditActions'
import { DeliveryHistory } from '@/components/receipts/DeliveryHistory'
import { ButtonLink } from '@/components/ui/Button'

export const metadata: Metadata = { title: 'Credit memo' }

export default async function CreditMemoPage(props: PageProps<'/credits/[id]'>) {
  const { id } = await props.params
  const ctx = await requireAuth()

  const doc = await getCreditDocument(ctx, id).catch((error: unknown) => {
    if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound()
    throw error
  })

  const deliveries = await listDeliveries(ctx, { kind: 'creditMemo', id })

  const total = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: doc.currency,
    minimumFractionDigits: 2,
  }).format(Number(doc.total))

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6 print:max-w-none print:p-0 print:pb-0">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Link
          href={`/customers/${doc.customerId}/account`}
          className="inline-flex min-h-touch items-center gap-1 text-sm font-semibold text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Account
        </Link>
        {doc.saleId ? (
          <ButtonLink href={`/receipts/${doc.saleId}`} size="sm" variant="secondary">
            Original invoice
          </ButtonLink>
        ) : null}
      </div>

      <ReceiptPaper doc={doc} />

      <CreditActions
        creditMemoId={id}
        number={doc.receiptNumber}
        customerName={doc.billTo.name}
        customerEmail={doc.billTo.email}
        customerPhone={doc.billTo.phone}
        total={total}
        amount={doc.total}
        remaining={doc.credit?.remaining ?? '0.00'}
        currency={doc.currency}
        canSend={can(ctx, 'receipt:send')}
        canApply={can(ctx, 'credit:apply')}
        canRefund={can(ctx, 'refund:create')}
        voided={doc.status === 'VOIDED'}
      />

      {deliveries.length > 0 ? (
        <DeliveryHistory rows={deliveries} timeZone={doc.timeZone} />
      ) : null}
    </div>
  )
}
