import type { ReceiptDocument } from './types'

/**
 * What the store actually reads (spec §25).
 *
 * Plain, short, and honest about the one thing that matters: whether money is
 * still owed. Both bodies are built from the same document value as the PDF, so
 * the email cannot claim a total the attachment disagrees with.
 *
 * A voided sale says so first. Somebody who kept the original email must not be
 * able to wave it as proof of a live invoice.
 */

export function renderReceiptEmail(
  doc: ReceiptDocument,
  options: { shareUrl: string; note?: string | null },
): { subject: string; text: string; html: string } {
  const owed = Number(doc.balanceDue) > 0
  const kind = owed ? 'Invoice' : 'Receipt'

  const subject = doc.void
    ? `VOIDED — ${kind} ${doc.receiptNumber} from ${doc.issuer.name}`
    : `${kind} ${doc.receiptNumber} from ${doc.issuer.name}`

  const facts: [string, string][] = [
    [`${kind} no.`, doc.receiptNumber],
    ['Date', formatDate(doc.occurredAt, doc.timeZone)],
    ['Total', money(doc.total, doc.currency)],
  ]
  if (Number(doc.amountPaid) > 0) facts.push(['Paid', money(doc.amountPaid, doc.currency)])
  facts.push([
    owed ? 'Balance due' : 'Balance',
    owed ? money(doc.balanceDue, doc.currency) : 'Paid in full',
  ])
  if (owed && doc.dueDate) facts.push(['Due by', formatDate(doc.dueDate, doc.timeZone)])

  const voidNotice = doc.void
    ? `This ${kind.toLowerCase()} was voided on ${formatDate(doc.void.voidedAt, doc.timeZone)}${
        doc.void.reason ? ` (${doc.void.reason})` : ''
      }. Nothing is owed on it.`
    : null

  const text = [
    `Hello ${doc.billTo.name},`,
    '',
    voidNotice,
    voidNotice ? '' : null,
    options.note?.trim() || null,
    options.note?.trim() ? '' : null,
    `Your ${kind.toLowerCase()} from ${doc.issuer.name} is attached as a PDF.`,
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    '',
    'You can also view it online:',
    options.shareUrl,
    '',
    doc.footer ?? 'Thank you for your business.',
    '',
    [doc.issuer.name, doc.issuer.phone, doc.issuer.email].filter(Boolean).join(' · '),
  ]
    .filter((line) => line !== null)
    .join('\n')

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">
    <h1 style="margin:0 0 4px;font-size:18px">${escapeHtml(doc.issuer.name)}</h1>
    <p style="margin:0 0 20px;font-size:13px;color:#64748b">${escapeHtml(kind)} ${escapeHtml(doc.receiptNumber)}</p>

    ${
      voidNotice
        ? `<p style="margin:0 0 20px;padding:12px;border:1px solid #fca5a5;background:#fef2f2;border-radius:8px;font-size:13px;color:#b91c1c"><strong>Voided.</strong> ${escapeHtml(voidNotice)}</p>`
        : ''
    }

    <p style="margin:0 0 16px;font-size:14px">Hello ${escapeHtml(doc.billTo.name)}, your ${escapeHtml(kind.toLowerCase())} is attached as a PDF.</p>
    ${options.note?.trim() ? `<p style="margin:0 0 16px;font-size:14px">${escapeHtml(options.note.trim())}</p>` : ''}

    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px">
      ${facts
        .map(
          ([label, value]) =>
            `<tr><td style="padding:4px 0;color:#64748b">${escapeHtml(label)}</td><td style="padding:4px 0;text-align:right;font-weight:600">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}
    </table>

    <p style="margin:0 0 20px">
      <a href="${escapeHtml(options.shareUrl)}" style="display:inline-block;background:#0f2a4a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600">View ${escapeHtml(kind.toLowerCase())} online</a>
    </p>

    <p style="margin:0;font-size:12px;color:#64748b">${escapeHtml(doc.footer ?? 'Thank you for your business.')}</p>
    <p style="margin:12px 0 0;font-size:12px;color:#94a3b8">${escapeHtml([doc.issuer.name, doc.issuer.phone, doc.issuer.email].filter(Boolean).join(' · '))}</p>
  </div>
</body></html>`

  return { subject, text, html }
}

/** One SMS segment where possible: who, how much, and the link. */
export function renderReceiptSms(doc: ReceiptDocument, shareUrl: string): string {
  if (doc.void) {
    return `${doc.issuer.name}: receipt ${doc.receiptNumber} was VOIDED. Nothing is owed. ${shareUrl}`
  }

  const owed = Number(doc.balanceDue) > 0
  const tail = owed
    ? `${money(doc.balanceDue, doc.currency)} due${doc.dueDate ? ` by ${formatDate(doc.dueDate, doc.timeZone)}` : ''}`
    : 'paid in full'

  return `${doc.issuer.name}: ${doc.receiptNumber} for ${money(doc.total, doc.currency)}, ${tail}. ${shareUrl}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function money(value: string, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(value))
}

function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(new Date(iso))
}
