import { notFound } from 'next/navigation'
import { getPublicReceiptDocument } from '@/server/documents/receiptDocument'
import { receiptFileName, renderReceiptPdf } from '@/server/documents/receiptPdf'
import { resolveShareToken } from '@/server/services/shareLink.service'
import { fileResponse } from '@/app/api/v1/_lib/handler'

export const runtime = 'nodejs'

/** The same PDF the office downloads, for whoever holds the link. */
export async function GET(_request: Request, context: RouteContext<'/r/[token]/pdf'>) {
  const { token } = await context.params

  const link = await resolveShareToken(token)
  if (!link) notFound()

  const doc = await getPublicReceiptDocument(link.organizationId, link.saleId)
  const pdf = await renderReceiptPdf(doc, 'full')

  return fileResponse(pdf, receiptFileName(doc), 'application/pdf', 'inline')
}
