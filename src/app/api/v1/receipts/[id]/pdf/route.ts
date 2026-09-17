import { getReceiptDocument } from '@/server/documents/receiptDocument'
import { receiptFileName, renderReceiptPdf, type PdfLayout } from '@/server/documents/receiptPdf'
import { recordDelivery } from '@/server/services/delivery.service'
import { apiError, fileResponse, requireApiAuth } from '@/app/api/v1/_lib/handler'

/** pdf-lib needs Node Buffers and the document assembler needs the database. */
export const runtime = 'nodejs'

export async function GET(request: Request, context: RouteContext<'/api/v1/receipts/[id]/pdf'>) {
  try {
    const ctx = await requireApiAuth()
    const { id } = await context.params

    const url = new URL(request.url)
    const layout: PdfLayout = url.searchParams.get('layout') === 'thermal' ? 'thermal' : 'full'
    const inline = url.searchParams.get('disposition') === 'inline'

    // Scoped through the tenant client, so a sale belonging to another company
    // simply is not found — and a runner without sale:read sees only their own.
    const doc = await getReceiptDocument(ctx, id, { includeSignatureImage: true })
    const pdf = await renderReceiptPdf(doc, layout)

    // A document leaving the building is worth a line in the log, so "what did
    // we send this store, and when" has an answer (spec §25).
    await recordDelivery(ctx, {
      saleId: doc.saleId,
      channel: layout === 'thermal' ? 'PRINT' : 'DOWNLOAD',
      status: 'SENT',
    })

    return fileResponse(
      pdf,
      receiptFileName(doc, layout),
      'application/pdf',
      inline ? 'inline' : 'attachment',
    )
  } catch (error) {
    return apiError(error)
  }
}
