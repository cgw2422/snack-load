import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Download } from 'lucide-react'
import { getPublicReceiptDocument } from '@/server/documents/receiptDocument'
import { resolveShareToken } from '@/server/services/shareLink.service'
import { ReceiptPaper } from '@/components/receipts/ReceiptPaper'

/**
 * The receipt a store opens from an email or a text (spec §25).
 *
 * No session, no navigation, nothing but the one document the token grants.
 * The token is the only input, and it is resolved to a sale id server-side —
 * there is no id in this URL for a visitor to change, and nothing on the page
 * links to another record.
 */
export const metadata: Metadata = {
  title: 'Receipt',
  // A receipt is a private document. It should not turn up in a search index
  // because somebody pasted the link into a public thread.
  robots: { index: false, follow: false, nocache: true },
}

export const dynamic = 'force-dynamic'

export default async function PublicReceiptPage(props: PageProps<'/r/[token]'>) {
  const { token } = await props.params

  const link = await resolveShareToken(token)
  // Expired, revoked, and never-existed are one answer on purpose: a visitor
  // learns nothing about which receipts exist.
  if (!link) notFound()

  const doc = await getPublicReceiptDocument(link.organizationId, link.saleId)

  return (
    <main className="min-h-dvh bg-surface-sunken px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto w-full max-w-md space-y-4">
        <ReceiptPaper doc={doc} />

        <div className="print:hidden">
          <a
            href={`/r/${token}/pdf`}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-navy-800 text-sm font-semibold text-white transition-colors hover:bg-navy-700"
          >
            <Download className="size-4" aria-hidden="true" />
            Download PDF
          </a>
          <p className="mt-3 text-center text-xs text-ink-subtle">
            Questions about this {Number(doc.balanceDue) > 0 ? 'invoice' : 'receipt'}? Contact{' '}
            {doc.issuer.name}
            {doc.issuer.phone ? ` at ${doc.issuer.phone}` : ''}.
          </p>
        </div>
      </div>
    </main>
  )
}
