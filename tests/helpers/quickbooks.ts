import { randomUUID } from 'node:crypto'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { seal } from '@/server/crypto/secretBox'
import { readSettings, type QuickBooksSettings } from '@/server/integrations/quickbooks/settings'
import { createFakeQuickBooks, type FakeQuickBooks } from '@/server/integrations/quickbooks/fake'
import { setQuickBooksClientForTesting } from '@/server/services/integration.service'
import { drain } from '@/server/integrations/quickbooks/sync/worker'
import type { Prisma } from '@/generated/prisma/client'
import type { TestOrg } from '../helpers'

/**
 * A connected QuickBooks company, for integration tests.
 *
 * Connects the organization the way the OAuth callback would — sealed tokens, a
 * realm, a CONNECTED status — and points the service layer at a fake Intuit.
 * The tests then drive the real worker, the real syncers and the real payload
 * builders; only the transport is substituted.
 */

export const DEFAULT_ACCOUNTS: QuickBooksSettings['accounts'] = {
  salesIncome: { id: '1', name: 'Sales of Product Income' },
  returnsAndDiscounts: { id: '2', name: 'Discounts given' },
  accountsReceivable: { id: '3', name: 'Accounts Receivable (A/R)' },
  undepositedFunds: { id: '4', name: 'Undeposited Funds' },
  costOfGoodsSold: { id: '5', name: 'Cost of Goods Sold' },
  inventoryAsset: { id: '6', name: 'Inventory Asset' },
  salesTaxPayable: { id: '7', name: 'Sales Tax Payable' },
  refundClearing: { id: '8', name: 'Checking' },
}

export async function connectQuickBooks(
  org: TestOrg,
  options: {
    accounts?: Partial<QuickBooksSettings['accounts']>
    automatedSalesTax?: boolean
    environment?: 'SANDBOX' | 'PRODUCTION'
    realmId?: string
  } = {},
): Promise<FakeQuickBooks> {
  const settings = readSettings(null)
  settings.accounts = { ...DEFAULT_ACCOUNTS, ...(options.accounts ?? {}) }
  settings.tax.automatedSalesTaxEnabled = options.automatedSalesTax ?? false
  if (options.automatedSalesTax) {
    settings.tax.taxCodeRef = { id: 'TAX', name: 'Automated sales tax' }
  }

  await unsafeDb.integrationConnection.upsert({
    where: {
      organizationId_provider: {
        organizationId: org.organizationId,
        provider: 'QUICKBOOKS_ONLINE',
      },
    },
    create: {
      organizationId: org.organizationId,
      provider: 'QUICKBOOKS_ONLINE',
      status: 'CONNECTED',
      environment: options.environment ?? 'SANDBOX',
      realmId: options.realmId ?? '4620816365320400000',
      companyName: 'Sandbox Company_US_1',
      accessTokenEncrypted: seal(`access-${randomUUID()}`),
      refreshTokenEncrypted: seal(`refresh-${randomUUID()}`),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: new Date(Date.now() + 8_726_400_000),
      grantedScope: 'com.intuit.quickbooks.accounting',
      connectedAt: new Date(),
      settingsJson: settings as unknown as Prisma.InputJsonObject,
    },
    update: {
      status: 'CONNECTED',
      environment: options.environment ?? 'SANDBOX',
      realmId: options.realmId ?? '4620816365320400000',
      settingsJson: settings as unknown as Prisma.InputJsonObject,
    },
  })

  const fake = createFakeQuickBooks({
    realmId: options.realmId ?? '4620816365320400000',
    environment: options.environment ?? 'SANDBOX',
    automatedSalesTax: options.automatedSalesTax,
  })
  setQuickBooksClientForTesting(fake)
  return fake
}

export function disconnectFake(): void {
  setQuickBooksClientForTesting(null)
}

/**
 * Runs the worker until the queue settles.
 *
 * Repeated passes on purpose: a blocked invoice is released by its customer's
 * success, and the release only takes effect on the next claim. Two or three
 * passes is what the real cron does over a few minutes.
 */
export async function runSync(
  org: TestOrg,
  client: FakeQuickBooks,
  passes = 6,
): Promise<{ synced: number; failed: number; blocked: number }> {
  const total = { synced: 0, failed: 0, blocked: 0 }

  for (let pass = 0; pass < passes; pass++) {
    const result = await drain({ organizationId: org.organizationId, client, limit: 200 })
    total.synced += result.synced
    total.failed += result.failed
    total.blocked += result.blocked
    if (result.processed === 0) break
  }

  return total
}

/** Every job, for asserting the state machine rather than guessing at it. */
export async function jobsFor(org: TestOrg) {
  return db(org.ownerCtx).syncJob.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, entityType: true, localId: true, operation: true, status: true,
      attempts: true, requestId: true, errorCategory: true, lastError: true,
      blockedOnJobId: true,
    },
  })
}

export async function jobFor(org: TestOrg, entityType: string, localId?: string) {
  const jobs = await jobsFor(org)
  return jobs.find((job) => job.entityType === entityType && (!localId || job.localId === localId))
}

export async function mappingFor(org: TestOrg, entityType: string, localId: string) {
  return db(org.ownerCtx).externalMapping.findFirst({
    where: { provider: 'QUICKBOOKS_ONLINE', entityType, localId },
  })
}
