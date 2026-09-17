import { getCreditDocument } from '@/server/documents/creditDocument'
import { receiptFileName, renderReceiptPdf, type PdfLayout } from '@/server/documents/receiptPdf'
import { recordDelivery } from '@/server/services/delivery.service'
import { apiError, fileResponse, requireApiAuth } from '@/app/api/v1/_lib/handler'

export const runtime = 'nodejs'

export async function GET(request: Request, context: RouteContext<'/api/v1/credits/[id]/pdf'>) {
  try {
    const ctx = await requireApiAuth()
    const { id } = await context.params

    const url = new URL(request.url)
    const layout: PdfLayout = url.searchParams.get('layout') === 'thermal' ? 'thermal' : 'full'

    const doc = await getCreditDocument(ctx, id)
    const pdf = await renderReceiptPdf(doc, layout)

    await recordDelivery(ctx, {
      document: { kind: 'creditMemo', id },
      channel: layout === 'thermal' ? 'PRINT' : 'DOWNLOAD',
      status: 'SENT',
    })

    return fileResponse(
      pdf,
      receiptFileName(doc, layout),
      'application/pdf',
      url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment',
    )
  } catch (error) {
    return apiError(error)
  }
}
