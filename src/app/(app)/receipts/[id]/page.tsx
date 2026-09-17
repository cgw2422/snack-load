import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { getSaleForReceipt } from '@/server/services/sale.service'
import { isAppError } from '@/lib/errors'
import { ReceiptDocument } from '@/components/receipts/ReceiptDocument'
import { ReceiptActions } from '@/components/receipts/ReceiptActions'
import { ButtonLink } from '@/components/ui/Button'

export const metadata: Metadata = { title: 'Receipt' }

export default async function ReceiptPage(props: PageProps<'/receipts/[id]'>) {
  const { id } = await props.params
  const ctx = await requireAuth()

  const receipt = await getSaleForReceipt(ctx, id).catch((error: unknown) => {
    // getSaleForReceipt raises NOT_FOUND both for a missing sale and for one
    // belonging to another runner — a 404 is the honest answer to both.
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound()
    throw error
  })

  const organization = await db(ctx).organization.findFirstOrThrow({
    where: { id: ctx.organizationId },
    select: {
      name: true, phone: true, addressLine1: true, city: true, state: true,
      postalCode: true, currency: true,
    },
  })

  const addressLine =
    [
      organization.addressLine1,
      [organization.city, organization.state].filter(Boolean).join(', '),
      organization.postalCode,
    ]
      .filter(Boolean)
      .join(' · ') || null

  const currency = organization.currency
  const total = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(receipt.total))

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
        <ButtonLink href={`/customers/${receipt.customer.id}`} size="sm" variant="secondary">
          {receipt.customer.name}
        </ButtonLink>
      </div>

      <ReceiptDocument
        receipt={receipt}
        organization={{
          name: organization.name,
          addressLine,
          phone: organization.phone,
          currency,
        }}
        timeZone={ctx.organization.timezone}
      />

      <ReceiptActions
        saleId={receipt.id}
        receiptNumber={receipt.receiptNumber}
        customerName={receipt.customer.name}
        total={total}
        canVoid={can(ctx, 'sale:void')}
        voided={receipt.status === 'VOIDED'}
      />

      {Number(receipt.balanceDue) > 0 &&
      receipt.status !== 'VOIDED' &&
      (can(ctx, 'payment:create') || can(ctx, 'payment:read')) ? (
        <div className="print:hidden">
          <ButtonLink
            href={`/receivables?customerId=${receipt.customer.id}`}
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
