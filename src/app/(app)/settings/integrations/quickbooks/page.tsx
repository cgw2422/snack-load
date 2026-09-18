import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAuth } from '@/server/auth/context'
import { can } from '@/server/auth/context'
import {
  describeConnection,
  listQuickBooksAccounts,
  listSyncHistory,
  listSplitPayments,
  listSyncIssues,
} from '@/server/services/integration.service'
import { listCogsBatches } from '@/server/services/cogs.service'
import type { QboAccount } from '@/server/integrations/quickbooks/types'
import { QuickBooksScreen } from '@/components/integrations/QuickBooksScreen'

export const metadata: Metadata = { title: 'QuickBooks Online' }

const BANNERS: Record<string, string> = {
  yes: 'Connected. Choose your accounts below, then press Sync now.',
  cancelled: 'The QuickBooks connection was cancelled. Nothing changed.',
  incomplete: 'QuickBooks did not send back everything we needed. Please try again.',
  refused: 'QuickBooks refused that connection request. Start again from Connect.',
  failed: 'Something went wrong finishing the connection. Please try again.',
}

export default async function Page({ searchParams }: PageProps<'/settings/integrations/quickbooks'>) {
  const ctx = await requireAuth()
  if (!can(ctx, 'org:manage_integrations')) redirect('/settings')

  const params = await searchParams
  const outcome = typeof params.connected === 'string' ? params.connected : null
  const company = typeof params.company === 'string' ? params.company : null

  const [connection, issues, history, cogsBatches, splitPayments] = await Promise.all([
    describeConnection(ctx),
    listSyncIssues(ctx),
    listSyncHistory(ctx),
    listCogsBatches(ctx),
    listSplitPayments(ctx),
  ])

  /**
   * The chart of accounts is read live rather than cached: an account added in
   * QuickBooks five minutes ago should be selectable now, and a stale copy is
   * how somebody maps revenue to an account that no longer exists.
   *
   * A failure here is not a failure of the page — the rest of it is still
   * useful, and the mapping form simply has nothing to offer.
   */
  let accounts: QboAccount[] = []
  if (connection.status === 'CONNECTED') {
    try {
      accounts = await listQuickBooksAccounts(ctx)
    } catch {
      accounts = []
    }
  }

  const banner = outcome
    ? outcome === 'yes' && company
      ? `Connected to ${company}. Choose your accounts below, then press Sync now.`
      : (BANNERS[outcome] ?? null)
    : null

  return (
    <QuickBooksScreen
      connection={connection}
      issues={issues}
      history={history}
      accounts={accounts}
      cogsBatches={cogsBatches}
      splitPayments={splitPayments}
      currency={ctx.organization.currency}
      banner={banner}
    />
  )
}
