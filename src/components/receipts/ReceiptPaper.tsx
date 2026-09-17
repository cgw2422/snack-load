import { Check, TriangleAlert } from 'lucide-react'
import type { ReceiptDocument } from '@/server/documents/types'

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash', CHECK: 'Check', CARD: 'Card', ACH: 'ACH', OTHER: 'Other', CREDIT: 'Account credit',
}

/**
 * The sale document on screen (spec §24).
 *
 * Renders the same `ReceiptDocument` value the PDF does, so the page a store
 * reads and the file they download can never disagree. Every figure is a
 * snapshot taken when the sale posted — product names, unit labels and prices
 * included — and a voided sale carries its stamp wherever it is shown.
 *
 * One column at 80 mm so it prints on a thermal roll; `print:` utilities drop
 * the chrome for a full page.
 */
export function ReceiptPaper({ doc }: { doc: ReceiptDocument }) {
  const currency = doc.currency
  const timeZone = doc.timeZone
  const isCredit = doc.kind === 'creditMemo'
  // On a credit memo the "balance" is unspent credit, which is a good thing to
  // have rather than a debt, so the wording flips with it.
  const owed = Number(doc.balanceDue) > 0

  return (
    <article className="mx-auto w-full max-w-[80mm] space-y-3 rounded-card border border-line bg-surface-raised p-4 text-ink print:max-w-none print:rounded-none print:border-0 print:p-0">
      <header className="space-y-0.5 text-center">
        {doc.logoUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element --
             a configured logo is an arbitrary URL or a data URL; next/image
             cannot optimise either and the receipt is a print document, not a
             page whose LCP anyone measures. */
          <img src={doc.logoUrl} alt="" className="mx-auto mb-1 max-h-12 w-auto object-contain" />
        ) : null}
        <h1 className="text-base font-extrabold">{doc.issuer.name}</h1>
        {isCredit ? (
          <p className="text-[11px] font-bold uppercase tracking-widest text-flame-600">
            Credit memo
          </p>
        ) : null}
        {doc.issuer.addressLines.map((line) => (
          <p key={line} className="text-[11px] text-ink-muted">
            {line}
          </p>
        ))}
        {doc.issuer.phone || doc.issuer.email ? (
          <p className="text-[11px] text-ink-muted">
            {[doc.issuer.phone, doc.issuer.email].filter(Boolean).join(' · ')}
          </p>
        ) : null}
      </header>

      {doc.void ? (
        <div className="rounded-lg border border-stop-500/40 bg-stop-500/5 px-3 py-2 text-center">
          <p className="flex items-center justify-center gap-1.5 text-sm font-bold uppercase tracking-wide text-stop-600">
            <TriangleAlert className="size-4" aria-hidden="true" />
            Voided
          </p>
          <p className="mt-0.5 text-[11px] text-stop-600">
            {formatDateTime(doc.void.voidedAt, timeZone)}
            {doc.void.voidedByName ? ` · ${doc.void.voidedByName}` : ''}
          </p>
          {doc.void.reason ? (
            <p className="text-[11px] text-stop-600">{doc.void.reason}</p>
          ) : null}
        </div>
      ) : null}

      {isCredit ? (
        <dl className="space-y-0.5 border-y border-dashed border-line py-2 text-[11px]">
          <Line label="Credit memo" value={doc.receiptNumber} />
          {doc.credit?.againstSaleNumber ? (
            <Line label="Original invoice" value={doc.credit.againstSaleNumber} />
          ) : null}
          <Line label="Return" value={doc.saleNumber} />
          <Line label="Date" value={formatDateTime(doc.occurredAt, timeZone)} />
          <Line label="Reason" value={doc.credit?.reason ?? ''} />
          {doc.soldByName ? <Line label="Issued by" value={doc.soldByName} /> : null}
        </dl>
      ) : (
        <dl className="space-y-0.5 border-y border-dashed border-line py-2 text-[11px]">
          <Line label={owed ? 'Invoice' : 'Receipt'} value={doc.receiptNumber} />
          <Line label="Order" value={doc.saleNumber} />
          <Line label="Date" value={formatDateTime(doc.occurredAt, timeZone)} />
          <Line label="Sold by" value={doc.soldByName} />
          <Line label="Terms" value={doc.paymentTermsCode} />
        </dl>
      )}

      <div className="text-[11px]">
        <p className="text-sm font-bold">{doc.billTo.name}</p>
        {doc.billTo.subtitle ? <p className="text-ink-muted">{doc.billTo.subtitle}</p> : null}
        {doc.billTo.addressLines.map((line) => (
          <p key={line} className="text-ink-muted">
            {line}
          </p>
        ))}
      </div>

      <table className="w-full border-y border-dashed border-line py-2 text-[11px]">
        <thead className="sr-only">
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((item) => (
            <tr key={item.id} className="align-top">
              <td className="py-1 pr-2">
                <span className="block font-semibold">{item.name}</span>
                <span className="block text-ink-muted">
                  {item.quantity} × {item.uomLabel} @ {money(item.unitPrice, currency)}
                </span>
                {Number(item.discountAmount) > 0 ? (
                  <span className="block text-cash-700">
                    less {money(item.discountAmount, currency)}
                  </span>
                ) : null}
              </td>
              {/* The extended price, before discount and tax, so this column
                  adds up to the Subtotal printed below it. */}
              <td className="tnum py-1 text-right font-semibold">
                {money(item.lineSubtotal, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="space-y-0.5 text-[11px]">
        <Line label="Subtotal" value={money(doc.subtotal, currency)} />
        {Number(doc.discountTotal) > 0 ? (
          <Line label="Discount" value={`−${money(doc.discountTotal, currency)}`} />
        ) : null}
        <Line label="Tax" value={money(doc.taxTotal, currency)} />

        <div className="flex items-baseline justify-between border-t border-line pt-1 text-base">
          <dt className="font-bold">{isCredit ? 'Total credit' : 'Total'}</dt>
          <dd className="tnum font-extrabold">{money(doc.total, currency)}</dd>
        </div>

        {doc.payments.map((payment, index) => (
          <Line
            key={`${payment.method}-${index}`}
            label={`${isCredit ? 'Refunded' : 'Paid'} · ${METHOD_LABEL[payment.method] ?? payment.method}${payment.reference ? ` #${payment.reference}` : ''}`}
            value={money(payment.amount, currency)}
          />
        ))}

        {isCredit ? (
          <>
            {Number(doc.credit?.applied ?? 0) > 0 ? (
              <Line label="Applied to invoices" value={money(doc.credit!.applied, currency)} />
            ) : null}
            <div className="flex items-baseline justify-between border-t border-line pt-1">
              <dt className="font-bold">Credit remaining</dt>
              <dd className="tnum text-sm font-extrabold text-cash-700">
                {money(doc.credit?.remaining ?? '0', currency)}
              </dd>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-baseline justify-between border-t border-line pt-1">
              <dt className="font-bold">{owed ? 'Balance due' : 'Paid in full'}</dt>
              <dd
                className={`tnum text-sm font-extrabold ${owed ? 'text-alert-600' : 'text-cash-700'}`}
              >
                {owed ? (
                  money(doc.balanceDue, currency)
                ) : (
                  <Check className="inline size-4" aria-label="Paid in full" />
                )}
              </dd>
            </div>

            {owed && doc.dueDate ? (
              <Line label="Due" value={formatDate(doc.dueDate, timeZone)} />
            ) : null}
          </>
        )}
      </dl>

      {isCredit && doc.credit ? (
        <div className="space-y-1 border-t border-dashed border-line pt-2 text-[11px]">
          <p className="font-semibold text-ink">{doc.credit.disposition}</p>
          {doc.credit.returnedLines.length > 0 ? (
            <ul className="text-ink-muted">
              {doc.credit.returnedLines.map((line, index) => (
                <li key={index}>
                  {line.quantity} × {line.uomLabel} {line.name} — {line.disposition}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {doc.notes ? (
        <p className="border-t border-dashed border-line pt-2 text-[11px] text-ink-muted">
          {doc.notes}
        </p>
      ) : null}

      {doc.signature ? (
        <p className="border-t border-dashed border-line pt-2 text-center text-[11px] text-ink-muted">
          Signed{doc.signature.signerName ? ` by ${doc.signature.signerName}` : ''} ·{' '}
          {formatTime(doc.signature.capturedAt, timeZone)}
        </p>
      ) : null}

      <p className="pt-1 text-center text-[11px] text-ink-subtle">
        {doc.footer ?? 'Thank you for your business.'}
      </p>
    </article>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="min-w-0 truncate text-ink-muted">{label}</dt>
      <dd className="tnum shrink-0 font-semibold">{value}</dd>
    </div>
  )
}

function money(value: string, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(value))
}

function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso))
}

function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(new Date(iso))
}

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone }).format(new Date(iso))
}
