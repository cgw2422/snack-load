import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import {
  ChevronLeft, ChevronRight, Banknote, FileText, RotateCcw, Ticket, Wallet,
} from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { getAccountLedger, type LedgerEntryKind } from '@/server/services/accountLedger.service'
import { isAppError } from '@/lib/errors'
import { formatMoney } from '@/server/domain/money'
import { formatShortDate, formatTime } from '@/lib/dates'
import { Card } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'

export const metadata: Metadata = { title: 'Account' }

const ICONS: Record<LedgerEntryKind, typeof FileText> = {
  INVOICE: FileText,
  PAYMENT: Banknote,
  RETURN: RotateCcw,
  CREDIT: Ticket,
  REFUND: Wallet,
}

/**
 * One store's financial history in order (spec §11).
 *
 * Invoices, payments, returns, credits and refunds on one page, because the
 * question somebody brings here — "why does this store owe what it owes" — is
 * one question, and four separate screens is how it turns into an afternoon.
 */
export default async function AccountPage(props: PageProps<'/customers/[id]/account'>) {
  const { id } = await props.params
  const ctx = await requireAuth()
  if (!can(ctx, 'customer:read')) redirect('/')

  const ledger = await getAccountLedger(ctx, id).catch((error: unknown) => {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound()
    throw error
  })

  const currency = ctx.organization.currency
  const timeZone = ctx.organization.timezone
  const { position } = ledger
  const inCredit = Number(position.net) < 0

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 pb-nav md:px-6 md:py-6">
      <Link
        href={`/customers/${id}`}
        className="inline-flex min-h-touch items-center gap-1 text-sm font-semibold text-ink-muted hover:text-ink"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {ledger.customer.name}
      </Link>

      <div>
        <h1 className="text-xl font-extrabold text-ink">Account</h1>
        <p className="text-sm text-ink-muted">#{ledger.customer.accountNumber}</p>
      </div>

      {/* Open invoices and credit are shown separately on purpose: an unapplied
          credit has not reduced any invoice, and netting them would be a figure
          nobody can reconcile against a document (spec §12). */}
      <Card className="grid gap-3 p-4 sm:grid-cols-3">
        <Figure
          label="Open invoices"
          value={formatMoney(position.openInvoices, currency)}
          tone={Number(position.openInvoices) > 0 ? 'owed' : 'quiet'}
        />
        <Figure
          label="Credit held"
          value={formatMoney(position.totalCredit, currency)}
          tone={Number(position.totalCredit) > 0 ? 'credit' : 'quiet'}
          hint={
            Number(position.memoCredit) > 0 && Number(position.paymentCredit) > 0
              ? `${formatMoney(position.memoCredit, currency)} from credits, ${formatMoney(position.paymentCredit, currency)} over-paid`
              : undefined
          }
        />
        <Figure
          label={inCredit ? 'Net — in credit' : 'Net position'}
          value={formatMoney(
            inCredit ? String(Math.abs(Number(position.net))) : position.net,
            currency,
          )}
          tone={inCredit ? 'credit' : Number(position.net) > 0 ? 'owed' : 'quiet'}
        />
      </Card>

      <Card>
        {ledger.entries.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-muted">
            Nothing on this account yet.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {ledger.entries.map((entry) => {
              const Icon = ICONS[entry.kind]
              const when = new Date(entry.occurredAt)
              const signed = Number(entry.amount)

              const row = (
                <>
                  <Icon
                    className={`mt-0.5 size-4 shrink-0 ${entry.voided ? 'text-stop-600' : 'text-ink-subtle'}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`truncate text-sm font-semibold ${entry.voided ? 'text-ink-subtle line-through' : 'text-ink'}`}
                      >
                        {entry.reference}
                      </span>
                      {entry.voided ? <Pill tone="stop">Voided</Pill> : null}
                    </span>
                    <span className="block truncate text-xs text-ink-muted">
                      {entry.description}
                    </span>
                    <span className="block truncate text-xs text-ink-subtle">
                      {formatShortDate(when, timeZone)} {formatTime(when, timeZone)}
                      {entry.actorName ? ` · ${entry.actorName}` : ''}
                    </span>
                  </span>

                  <span className="w-28 shrink-0 text-right">
                    {signed !== 0 ? (
                      <span
                        className={`tnum block text-sm font-bold ${signed > 0 ? 'text-ink' : 'text-cash-700'}`}
                      >
                        {signed > 0 ? '' : '−'}
                        {formatMoney(String(Math.abs(signed)), currency)}
                      </span>
                    ) : null}
                    {entry.status ? (
                      <span className="block text-[11px] font-medium text-ink-subtle">
                        {entry.status}
                      </span>
                    ) : null}
                  </span>
                </>
              )

              return (
                <li key={entry.id}>
                  {entry.href ? (
                    <Link
                      href={entry.href}
                      className="flex min-h-touch items-start gap-2.5 px-4 py-3 transition-colors hover:bg-surface-sunken"
                    >
                      {row}
                      <ChevronRight
                        className="mt-0.5 size-4 shrink-0 text-ink-subtle"
                        aria-hidden="true"
                      />
                    </Link>
                  ) : (
                    <div className="flex min-h-touch items-start gap-2.5 px-4 py-3">
                      {row}
                      <span className="size-4 shrink-0" aria-hidden="true" />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone: 'owed' | 'credit' | 'quiet'
  hint?: string
}) {
  const colour =
    tone === 'owed' ? 'text-alert-600' : tone === 'credit' ? 'text-cash-700' : 'text-ink-subtle'

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">{label}</p>
      <p className={`tnum text-xl font-extrabold ${colour}`}>{value}</p>
      {hint ? <p className="text-[11px] text-ink-subtle">{hint}</p> : null}
    </div>
  )
}
