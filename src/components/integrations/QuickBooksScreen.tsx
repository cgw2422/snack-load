'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Link2,
  Link2Off,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { Field, Select } from '@/components/ui/Field'
import { Pill } from '@/components/ui/Pill'
import type { ConnectionView, SyncHistoryEntry, SyncIssue } from '@/server/services/integration.service'
import type { CogsBatchSummary } from '@/server/services/cogs.service'
import type { QboAccount } from '@/server/integrations/quickbooks/types'
import {
  backfillAction,
  connectAction,
  disconnectAction,
  mapManuallyAction,
  postCogsAction,
  prepareCogsAction,
  resyncAction,
  retryJobAction,
  saveSettingsAction,
  syncNowAction,
  voidCogsAction,
  type IntegrationState,
} from '@/app/(app)/settings/integrations/quickbooks/actions'

/**
 * Settings → Integrations → QuickBooks (docs/08 §2).
 *
 * The screen is organised around the question an operator actually arrives
 * with: *is my accounting up to date, and if not, what do I do about it?* So
 * the health line and the issues come before the configuration, and every issue
 * carries the one action that would resolve it rather than a log line.
 */

const STATUS: Record<
  ConnectionView['status'],
  { label: string; tone: 'neutral' | 'cash' | 'alert' | 'stop' | 'navy'; detail: string }
> = {
  NOT_CONNECTED: {
    label: 'Not connected',
    tone: 'neutral',
    detail: 'Sales, returns and payments are all being recorded. Nothing is going to QuickBooks.',
  },
  CONNECTING: {
    label: 'Connecting',
    tone: 'navy',
    detail: 'Waiting for QuickBooks to send you back. If nothing happens, start again.',
  },
  CONNECTED: { label: 'Connected', tone: 'cash', detail: '' },
  NEEDS_REAUTH: {
    label: 'Needs reconnecting',
    tone: 'alert',
    detail:
      'QuickBooks would not renew the connection. Everything is still being recorded here and will sync once you reconnect.',
  },
  ERROR: { label: 'Problem', tone: 'stop', detail: 'Something is wrong with the connection.' },
}

function Submit({ children, variant = 'secondary', size = 'md' }: {
  children: React.ReactNode
  variant?: 'primary' | 'secondary' | 'accent' | 'danger' | 'ghost'
  size?: 'sm' | 'md'
}) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending}>
      {pending ? 'Working…' : children}
    </Button>
  )
}

function Notice({ state }: { state: IntegrationState }) {
  if (!state.error && !state.message) return null
  return (
    <p
      role="status"
      className={
        state.error
          ? 'mt-2 rounded-lg bg-stop-500/10 px-3 py-2 text-sm text-stop-600'
          : 'mt-2 rounded-lg bg-cash-100 px-3 py-2 text-sm text-cash-700 dark:bg-cash-700/25 dark:text-cash-100'
      }
    >
      {state.error ?? state.message}
    </p>
  )
}

function when(value: Date | string | null): string {
  if (!value) return 'never'
  const date = typeof value === 'string' ? new Date(value) : value
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return date.toLocaleDateString()
}

export function QuickBooksScreen({
  connection,
  issues,
  history,
  accounts,
  cogsBatches,
  banner,
}: {
  connection: ConnectionView
  issues: SyncIssue[]
  history: SyncHistoryEntry[]
  accounts: QboAccount[]
  cogsBatches: CogsBatchSummary[]
  banner: string | null
}) {
  const [connectState, connect] = useActionState(connectAction, {})
  const [syncState, sync] = useActionState(
    async (): Promise<IntegrationState> => syncNowAction(),
    {},
  )
  const [disconnectState, disconnectNow] = useActionState(
    async (): Promise<IntegrationState> => disconnectAction(),
    {},
  )
  const [settingsState, save] = useActionState(saveSettingsAction, {})
  const [retryState, retry] = useActionState(retryJobAction, {})
  const [mapState, map] = useActionState(mapManuallyAction, {})
  const [backfillState, queuePast] = useActionState(backfillAction, {})
  const [cogsState, prepare] = useActionState(prepareCogsAction, {})
  const [postState, post] = useActionState(postCogsAction, {})
  const [voidState, voidBatch] = useActionState(voidCogsAction, {})
  const [resyncState, resync] = useActionState(resyncAction, {})

  const status = STATUS[connection.status]
  const connected = connection.status === 'CONNECTED'

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-24 pt-4">
      <header>
        <p className="text-xs font-bold uppercase tracking-wide text-ink-subtle">Integrations</p>
        <h1 className="text-xl font-bold text-ink">QuickBooks Online</h1>
        <p className="mt-1 text-sm text-ink-muted">
          SnackLoad keeps the sales, the stock and the route. QuickBooks gets the accounting copy.
        </p>
      </header>

      {banner ? (
        <p role="status" className="rounded-lg bg-navy-100 px-3 py-2 text-sm text-navy-700 dark:bg-navy-900/60 dark:text-navy-100">
          {banner}
        </p>
      ) : null}

      {/* ── connection ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Connection <Pill tone={status.tone}>{status.label}</Pill>
            </span>
          }
        />
        <div className="space-y-3 px-4 pb-4">
          {status.detail ? <p className="text-sm text-ink-muted">{status.detail}</p> : null}

          {connection.companyName ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-ink-subtle">Company</dt>
              <dd className="tnum font-semibold text-ink">{connection.companyName}</dd>
              <dt className="text-ink-subtle">Company ID</dt>
              <dd className="tnum break-all text-ink">{connection.realmId}</dd>
              <dt className="text-ink-subtle">Environment</dt>
              <dd>
                <Pill tone={connection.environment === 'PRODUCTION' ? 'flame' : 'neutral'}>
                  {connection.environment === 'PRODUCTION' ? 'Production' : 'Sandbox'}
                </Pill>
              </dd>
              <dt className="text-ink-subtle">Connected</dt>
              <dd className="text-ink">{when(connection.connectedAt)}</dd>
              <dt className="text-ink-subtle">Last successful sync</dt>
              <dd className="text-ink">{when(connection.lastSyncAt)}</dd>
              <dt className="text-ink-subtle">Last attempt</dt>
              <dd className="text-ink">{when(connection.lastSyncAttemptAt)}</dd>
            </dl>
          ) : null}

          {connection.lastError ? (
            <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-alert-600 dark:bg-alert-600/25 dark:text-amber-100">
              {connection.lastError}
            </p>
          ) : null}

          {!connection.available ? (
            <p className="rounded-lg bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
              QuickBooks is not configured on this server. An administrator needs to add the Intuit
              app credentials before anyone can connect.
            </p>
          ) : connected || connection.status === 'NEEDS_REAUTH' ? (
            <div className="flex flex-wrap gap-2">
              <form action={sync}>
                <Submit variant="primary">
                  <RefreshCw className="size-4" aria-hidden="true" /> Sync now
                </Submit>
              </form>
              <form action={connect}>
                <input type="hidden" name="environment" value={connection.environment} />
                <Submit>
                  <Link2 className="size-4" aria-hidden="true" /> Reconnect
                </Submit>
              </form>
              <form action={disconnectNow}>
                <Submit variant="ghost">
                  <Link2Off className="size-4" aria-hidden="true" /> Disconnect
                </Submit>
              </form>
            </div>
          ) : (
            <form action={connect} className="flex flex-wrap items-end gap-2">
              {/* Sandbox or production is chosen here, by a person, and stored
                  on the connection. It is never inferred (docs/08 §3). */}
              <Field label="Which QuickBooks" htmlFor="environment" className="min-w-48 flex-1">
                <Select id="environment" name="environment" defaultValue="SANDBOX">
                  <option value="SANDBOX">Sandbox — for trying it out</option>
                  <option value="PRODUCTION">Production — the real company books</option>
                </Select>
              </Field>
              <Submit variant="primary">
                <Link2 className="size-4" aria-hidden="true" /> Connect QuickBooks
              </Submit>
            </form>
          )}

          <Notice state={connectState} />
          <Notice state={syncState} />
          <Notice state={disconnectState} />
        </div>
      </Card>

      {/* ── health ─────────────────────────────────────────────────────── */}
      {connected || connection.status === 'NEEDS_REAUTH' ? (
        <Card>
          <CardHeader title="Sync health" />
          <div className="grid grid-cols-2 gap-3 px-4 pb-4 sm:grid-cols-4">
            {[
              { label: 'Synced today', value: connection.health.syncedToday, tone: 'cash' as const },
              { label: 'Queued', value: connection.health.pending, tone: 'neutral' as const },
              { label: 'Waiting on something', value: connection.health.blocked, tone: 'navy' as const },
              { label: 'Need attention', value: connection.health.needsAttention, tone: 'alert' as const },
            ].map((stat) => (
              <div key={stat.label} className="rounded-lg bg-surface-sunken px-3 py-2">
                <p className="tnum text-xl font-bold text-ink">{stat.value}</p>
                <p className="text-xs text-ink-muted">{stat.label}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* ── issues ─────────────────────────────────────────────────────── */}
      {issues.length > 0 ? (
        <Card>
          <CardHeader title={`Sync issues (${issues.length})`} />
          <ul className="divide-y divide-line">
            {issues.map((issue) => (
              <li key={issue.jobId} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink">
                      {issue.documentNumber ?? issue.entityType}
                      {issue.customerName ? (
                        <span className="font-normal text-ink-muted"> · {issue.customerName}</span>
                      ) : null}
                    </p>
                    <p className="text-xs text-ink-subtle">
                      {issue.entityType} · tried {issue.attempts}×{' '}
                      {issue.lastAttemptedAt ? `· ${when(issue.lastAttemptedAt)}` : ''}
                    </p>
                  </div>
                  <Pill tone={issue.status === 'BLOCKED_DEPENDENCY' ? 'navy' : 'alert'}>
                    {issue.status === 'BLOCKED_DEPENDENCY' ? 'Waiting' : 'Needs attention'}
                  </Pill>
                </div>

                {issue.message ? (
                  <p className="mt-1 text-sm text-ink-muted">{issue.message}</p>
                ) : null}
                <p className="mt-1 flex items-start gap-1.5 text-xs text-ink-subtle">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {issue.suggestion}
                </p>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <form action={retry}>
                    <input type="hidden" name="jobId" value={issue.jobId} />
                    <Submit size="sm">Retry</Submit>
                  </form>

                  {issue.action === 'REMAP_CUSTOMER' || issue.action === 'REMAP_ITEM' ? (
                    <form action={map} className="flex items-center gap-1.5">
                      <input
                        type="hidden"
                        name="entityType"
                        value={issue.action === 'REMAP_CUSTOMER' ? 'Customer' : 'Product'}
                      />
                      <input type="hidden" name="localId" value={issue.localId} />
                      <input
                        name="externalId"
                        inputMode="numeric"
                        placeholder="QuickBooks ID"
                        aria-label={`QuickBooks ID for ${issue.documentNumber ?? issue.entityType}`}
                        className="h-9 w-32 rounded-lg border border-line-strong bg-surface-raised px-2 text-sm"
                      />
                      <Submit size="sm">Map</Submit>
                    </form>
                  ) : null}

                  {issue.action === 'REVIEW_DOCUMENT' ? (
                    <form action={resync}>
                      <input type="hidden" name="entityType" value={issue.entityType} />
                      <input type="hidden" name="localId" value={issue.localId} />
                      <Submit size="sm">Send ours again</Submit>
                    </form>
                  ) : null}

                  {issue.href ? (
                    <a
                      href={issue.href}
                      className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-navy-700 hover:bg-surface-sunken dark:text-navy-100"
                    >
                      Open in SnackLoad <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <div className="px-4 pb-3">
            <Notice state={retryState} />
            <Notice state={mapState} />
            <Notice state={resyncState} />
          </div>
        </Card>
      ) : null}

      {/* ── account mapping ────────────────────────────────────────────── */}
      {connected ? (
        <Card>
          <CardHeader title="Account mapping" />
          <form action={save} className="space-y-3 px-4 pb-4">
            <p className="text-sm text-ink-muted">
              Chosen from your own chart of accounts. SnackLoad stores the QuickBooks ID, so renaming
              an account over there does not break anything here — and nothing is ever created on
              your behalf.
            </p>

            {(
              [
                ['salesIncome', 'Sales income', 'Where product revenue posts. Required before sales can sync.'],
                ['returnsAndDiscounts', 'Returns and discounts', 'Where a discount line posts.'],
                ['accountsReceivable', 'Accounts receivable', 'Only needed if you keep more than one A/R account.'],
                ['undepositedFunds', 'Undeposited funds', 'Where counter payments and sales receipts deposit.'],
                ['costOfGoodsSold', 'Cost of goods sold', 'Debited by the periodic COGS journal.'],
                ['inventoryAsset', 'Inventory asset', 'Credited by the same journal, so it balances.'],
                ['salesTaxPayable', 'Sales tax payable', 'For companies not on Automated Sales Tax.'],
                ['refundClearing', 'Refunds paid from', 'Where a cash refund comes out of.'],
              ] as const
            ).map(([key, label, hint]) => (
              <Field key={key} label={label} htmlFor={key} hint={hint}>
                <Select
                  id={key}
                  name={key}
                  defaultValue={connection.settings.accounts[key]?.id ?? ''}
                >
                  <option value="">— not chosen —</option>
                  {accounts.map((account) => (
                    <option key={account.Id} value={account.Id}>
                      {account.Name} ({account.AccountType})
                    </option>
                  ))}
                </Select>
              </Field>
            ))}

            <Field
              label="Documents posted before SnackLoad recorded tax detail"
              htmlFor="legacyPolicy"
              hint="Older documents carry a total and a tax amount but no rate or jurisdiction."
            >
              <Select
                id="legacyPolicy"
                name="legacyPolicy"
                defaultValue={connection.settings.tax.legacyPolicy}
              >
                <option value="TOTALS_ONLY">
                  Send the amounts as posted, and note that the detail is missing
                </option>
                <option value="REVIEW">Hold them for review instead</option>
              </Select>
            </Field>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="sendDocumentNumbers"
                defaultChecked={connection.settings.documents.sendDocumentNumbers}
                className="size-4"
              />
              Use SnackLoad document numbers in QuickBooks
              <span className="text-xs text-ink-subtle">
                (leave off if QuickBooks already numbers your invoices)
              </span>
            </label>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="referenceInPrivateNote"
                defaultChecked={connection.settings.documents.referenceInPrivateNote}
                className="size-4"
              />
              Put the SnackLoad reference in the private note
            </label>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="syncPaused"
                defaultChecked={connection.settings.syncPaused}
                className="size-4"
              />
              Pause syncing
              <span className="text-xs text-ink-subtle">(work still queues up)</span>
            </label>

            {connection.settings.tax.automatedSalesTaxEnabled ? (
              <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-alert-600 dark:bg-alert-600/25 dark:text-amber-100">
                This company uses QuickBooks&rsquo; Automated Sales Tax. SnackLoad sends the tax it
                actually charged as an explicit override. If QuickBooks records a different figure,
                that document is listed above rather than accepted.
              </p>
            ) : null}

            <Submit variant="primary">Save mapping</Submit>
            <Notice state={settingsState} />
          </form>
        </Card>
      ) : null}

      {/* ── COGS journals ──────────────────────────────────────────────── */}
      {connected ? (
        <Card>
          <CardHeader title="Cost of goods sold" />
          <div className="space-y-3 px-4 pb-4">
            <p className="text-sm text-ink-muted">
              QuickBooks does not hold SnackLoad&rsquo;s stock. Cost reaches it once a period, as a
              journal entry: what the sales in the period cost, less what came back on returns.
            </p>

            <form action={prepare} className="flex flex-wrap items-end gap-2">
              <Field label="From" htmlFor="from" className="flex-1">
                <input
                  id="from"
                  name="from"
                  type="date"
                  required
                  className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-sm"
                />
              </Field>
              <Field label="To" htmlFor="to" className="flex-1">
                <input
                  id="to"
                  name="to"
                  type="date"
                  required
                  className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-sm"
                />
              </Field>
              <Submit>Work it out</Submit>
            </form>
            <Notice state={cogsState} />
            <Notice state={postState} />
            <Notice state={voidState} />

            {cogsBatches.length > 0 ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {cogsBatches.map((batch) => (
                  <li key={batch.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink">
                        {batch.periodStart} – {batch.periodEnd}
                      </p>
                      <p className="tnum text-xs text-ink-muted">
                        {batch.totalCogs} = {batch.salesCogs} less {batch.returnCogs} ·{' '}
                        {batch.saleCount} sales, {batch.returnCount} credits
                      </p>
                    </div>
                    <Pill
                      tone={
                        batch.status === 'POSTED' ? 'cash' : batch.status === 'VOIDED' ? 'stop' : 'neutral'
                      }
                    >
                      {batch.status === 'POSTED'
                        ? batch.externalId
                          ? `QuickBooks #${batch.externalId}`
                          : 'Posted'
                        : batch.status === 'VOIDED'
                          ? 'Voided'
                          : 'Draft'}
                    </Pill>
                    {batch.status === 'DRAFT' ? (
                      <form action={post}>
                        <input type="hidden" name="batchId" value={batch.id} />
                        <Submit size="sm" variant="primary">Post</Submit>
                      </form>
                    ) : null}
                    {batch.status === 'POSTED' ? (
                      <form action={voidBatch}>
                        <input type="hidden" name="batchId" value={batch.id} />
                        <input type="hidden" name="reason" value="Superseded" />
                        <Submit size="sm" variant="ghost">Void</Submit>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* ── history ────────────────────────────────────────────────────── */}
      {history.length > 0 ? (
        <Card>
          <CardHeader title="Recent sync activity" />
          <ul className="divide-y divide-line">
            {history.map((entry) => (
              <li key={entry.jobId} className="flex items-center gap-3 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">
                    {entry.documentNumber ?? entry.entityType}
                    {entry.customerName ? (
                      <span className="font-normal text-ink-muted"> · {entry.customerName}</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-ink-subtle">
                    {entry.entityType} · {when(entry.at)}
                    {entry.externalId ? ` · QuickBooks #${entry.externalId}` : ''}
                  </p>
                </div>
                {entry.status === 'SYNCED' ? (
                  <Pill tone="cash">
                    <Check className="size-3" aria-hidden="true" /> Synced
                  </Pill>
                ) : entry.status === 'BLOCKED_DEPENDENCY' ? (
                  <Pill tone="navy">Waiting</Pill>
                ) : entry.status === 'PENDING' || entry.status === 'RETRYING' ? (
                  <Pill tone="neutral">Queued</Pill>
                ) : (
                  <Pill tone="alert">Needs attention</Pill>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* ── backfill ───────────────────────────────────────────────────── */}
      {connected ? (
        <Card>
          <CardHeader title="Send past documents" />
          <form action={queuePast} className="flex flex-wrap items-end gap-2 px-4 pb-4">
            <Field
              label="How far back"
              htmlFor="days"
              className="flex-1"
              hint="Only as far as you want QuickBooks to have. Periods you have already closed are best left alone."
            >
              <Select id="days" name="days" defaultValue="30">
                <option value="7">The last week</option>
                <option value="30">The last 30 days</option>
                <option value="90">The last quarter</option>
                <option value="365">The last year</option>
              </Select>
            </Field>
            <Submit>Queue them</Submit>
            <div className="w-full">
              <Notice state={backfillState} />
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  )
}
