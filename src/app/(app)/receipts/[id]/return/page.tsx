import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { getReturnableLines } from '@/server/services/return.service'
import { flattenSearchParams, firstValue } from '@/lib/searchParams'
import { isAppError } from '@/lib/errors'
import { ReturnScreen } from '@/components/returns/ReturnScreen'

export const metadata: Metadata = { title: 'Return items' }

export default async function ReturnPage(props: PageProps<'/receipts/[id]/return'>) {
  const { id } = await props.params
  const ctx = await requireAuth()
  if (!can(ctx, 'return:create')) redirect(`/receipts/${id}`)

  const view = await getReturnableLines(ctx, id).catch((error: unknown) => {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound()
    // A voided sale cannot be returned against. The sale still exists, so the
    // honest destination is the receipt itself rather than a 500 — which is
    // what this used to render for anyone who kept the URL in a tab.
    if (isAppError(error) && error.code === 'CONFLICT') redirect(`/receipts/${id}`)
    throw error
  })

  const raw = flattenSearchParams(await props.searchParams)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6">
      <Link
        href={`/receipts/${id}`}
        className="inline-flex min-h-touch items-center gap-1 text-sm font-semibold text-ink-muted hover:text-ink"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {view.saleNumber}
      </Link>

      <ReturnScreen
        saleId={id}
        saleNumber={view.saleNumber}
        customerName={view.customerName}
        lines={view.lines}
        routeStopId={firstValue(raw.stopId)}
        currency={ctx.organization.currency}
        canRefund={can(ctx, 'refund:create')}
      />
    </div>
  )
}
