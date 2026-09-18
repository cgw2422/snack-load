import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronRight, Plug } from 'lucide-react'
import { can, requireAuth } from '@/server/auth/context'
import { Card, CardHeader } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { describeConnection } from '@/server/services/integration.service'

export const metadata: Metadata = { title: 'Settings' }

/**
 * The settings hub.
 *
 * Only the integration is built out; the rest of what this screen will hold is
 * listed honestly as not yet there rather than rendered as dead links.
 */
export default async function Page() {
  const ctx = await requireAuth()
  const manages = can(ctx, 'org:manage_integrations')

  const connection = manages ? await describeConnection(ctx) : null
  const tone =
    connection?.status === 'CONNECTED'
      ? 'cash'
      : connection?.status === 'NEEDS_REAUTH'
        ? 'alert'
        : 'neutral'
  const label =
    connection?.status === 'CONNECTED'
      ? (connection.companyName ?? 'Connected')
      : connection?.status === 'NEEDS_REAUTH'
        ? 'Needs reconnecting'
        : 'Not connected'

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-24 pt-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Settings</h1>
        <p className="mt-1 text-sm text-ink-muted">Company, team and integrations.</p>
      </header>

      {manages ? (
        <Card>
          <CardHeader title="Integrations" />
          <Link
            href="/settings/integrations/quickbooks"
            className="flex items-center gap-3 px-4 py-3 hover:bg-surface-sunken"
          >
            <Plug className="size-5 shrink-0 text-ink-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">QuickBooks Online</span>
              <span className="block text-xs text-ink-muted">
                Send invoices, payments, credits and periodic cost to your accountant&rsquo;s books.
              </span>
            </span>
            <Pill tone={tone}>{label}</Pill>
            <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
          </Link>
          {connection && connection.health.needsAttention > 0 ? (
            <p className="border-t border-line px-4 py-2 text-xs text-alert-600">
              {connection.health.needsAttention} document
              {connection.health.needsAttention === 1 ? '' : 's'} need attention.
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Still to come" />
        <ul className="space-y-1 px-4 pb-4 text-sm text-ink-muted">
          <li>Company profile, address and receipt footer</li>
          <li>Tax rates and payment terms</li>
          <li>Audit history of important changes</li>
        </ul>
      </Card>
    </div>
  )
}
