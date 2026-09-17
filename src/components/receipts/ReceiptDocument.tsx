import { Check, TriangleAlert } from 'lucide-react'
import type { ReceiptView } from '@/server/services/sale.service'

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash', CHECK: 'Check', CARD: 'Card', ACH: 'ACH', CREDIT: 'Account credit',
}

function money(value: string | number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(value))
}

/**
 * The sale document (spec §24).
 *
 * Every figure here is a snapshot taken when the sale posted — product names,
 * unit labels and prices included — so a receipt printed a year from now reads
 * exactly as it did at the counter (docs/02 §L5). Nothing is recomputed.
 *
 * The layout is one column at 80mm so it prints on a thermal roll, and the
 * same markup carries to a full page; `print:` utilities drop the chrome.
 */
export function ReceiptDocument({
  receipt,
  organization,
  timeZone,
}: {
  receipt: ReceiptView
  organization: { name: string; addressLine: string | null; phone: string | null; currency: string }
  timeZone: string
}) {
  const currency = organization.currency
  const voided = receipt.status === 'VOIDED'

  const stamp = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(receipt.occurredAt))

  return (
    <article className="mx-auto w-full max-w-[80mm] space-y-3 rounded-card border border-line bg-surface-raised p-4 text-ink print:max-w-none print:rounded-none print:border-0 print:p-0">
      <header className="space-y-0.5 text-center">
        <h1 className="text-base font-extrabold">{organization.name}</h1>
        {organization.addressLine ? (
          <p className="text-[11px] text-ink-muted">{organization.addressLine}</p>
        ) : null}
        {organization.phone ? (
          <p className="text-[11px] text-ink-muted">{organization.phone}</p>
        ) : null}
      </header>

      {voided ? (
        <p className="flex items-center justify-center gap-1.5 rounded-lg border border-stop-500/40 bg-stop-500/5 px-3 py-2 text-sm font-bold uppercase tracking-wide text-stop-600">
          <TriangleAlert className="size-4" aria-hidden="true" />
          Voided
        </p>
      ) : null}

      <dl className="space-y-0.5 border-y border-dashed border-line py-2 text-[11px]">
        <Line label="Receipt" value={receipt.receiptNumber} />
        <Line label="Order" value={receipt.saleNumber} />
        <Line label="Date" value={stamp} />
        <Line label="Sold by" value={receipt.soldByName} />
        <Line label="Terms" value={receipt.paymentTermsCode} />
      </dl>

      <div className="text-[11px]">
        <p className="text-sm font-bold">{receipt.customer.name}</p>
        <p className="text-ink-muted">#{receipt.customer.accountNumber}</p>
        {receipt.customer.addressLine ? (
          <p className="text-ink-muted">{receipt.customer.addressLine}</p>
        ) : null}
      </div>

      <table className="w-full border-y border-dashed border-line py-2 text-[11px]">
        <thead className="sr-only">
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {receipt.items.map((item) => (
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
              <td className="tnum py-1 text-right font-semibold">
                {money(item.lineTotal, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="space-y-0.5 text-[11px]">
        <Line label="Subtotal" value={money(receipt.subtotal, currency)} />
        {Number(receipt.discountTotal) > 0 ? (
          <Line label="Discount" value={`−${money(receipt.discountTotal, currency)}`} />
        ) : null}
        <Line label="Tax" value={money(receipt.taxTotal, currency)} />

        <div className="flex items-baseline justify-between border-t border-line pt-1 text-base">
          <dt className="font-bold">Total</dt>
          <dd className="tnum font-extrabold">{money(receipt.total, currency)}</dd>
        </div>

        {receipt.payments.map((payment, index) => (
          <Line
            key={`${payment.method}-${index}`}
            label={`Paid · ${METHOD_LABEL[payment.method] ?? payment.method}${payment.reference ? ` #${payment.reference}` : ''}`}
            value={money(payment.amount, currency)}
          />
        ))}

        <div className="flex items-baseline justify-between border-t border-line pt-1">
          <dt className="font-bold">
            {Number(receipt.balanceDue) > 0 ? 'Balance due' : 'Paid in full'}
          </dt>
          <dd
            className={`tnum text-sm font-extrabold ${
              Number(receipt.balanceDue) > 0 ? 'text-alert-600' : 'text-cash-700'
            }`}
          >
            {Number(receipt.balanceDue) > 0 ? (
              money(receipt.balanceDue, currency)
            ) : (
              <Check className="inline size-4" aria-label="Paid in full" />
            )}
          </dd>
        </div>

        {Number(receipt.balanceDue) > 0 && receipt.dueDate ? (
          <Line
            label="Due"
            value={new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(
              new Date(receipt.dueDate),
            )}
          />
        ) : null}
      </dl>

      {receipt.notes ? (
        <p className="border-t border-dashed border-line pt-2 text-[11px] text-ink-muted">
          {receipt.notes}
        </p>
      ) : null}

      {receipt.signature ? (
        <p className="border-t border-dashed border-line pt-2 text-center text-[11px] text-ink-muted">
          Signed{receipt.signature.signerName ? ` by ${receipt.signature.signerName}` : ''} ·{' '}
          {new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone }).format(
            new Date(receipt.signature.capturedAt),
          )}
        </p>
      ) : null}

      <p className="pt-1 text-center text-[11px] text-ink-subtle">Thank you for your business.</p>
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
