import { createHash } from 'node:crypto'
import { Prisma } from '@/generated/prisma/client'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { conflict, notFound } from '@/lib/errors'
import { m, toAmountString } from '@/server/domain/money'
import { dateOnly, endOfLocalDate, startOfLocalDate } from '@/lib/dates'
import { writeAudit } from './audit.service'
import {
  enqueueIfConnected,
  enqueueVoidIfConnected,
} from '@/server/integrations/quickbooks/sync/hooks'

/**
 * Periodic cost of goods sold (docs/08 §9).
 *
 * QuickBooks does not own SnackLoad's stock, so no truck load, transfer or
 * adjustment ever reaches it (docs/07 §3). What reaches it is one journal entry
 * per period: debit cost of goods sold, credit inventory asset, for what the
 * period actually cost.
 *
 * The arithmetic, and the reason each half is what it is:
 *
 *     COGS of sales posted in the period          (unit_cost_at_sale, frozen)
 *   − COGS reversed by credits issued in the period (the cost that came back)
 *   = the journal amount
 *
 * Both halves read `unit_cost_at_sale`, never a current product cost. That is
 * what makes the figure tie **exactly** to the gross-profit report for the same
 * window — the two run the same arithmetic over the same columns, and a test
 * asserts they agree rather than trusting that they do.
 *
 * A batch is a row rather than a calculation because a journal entry needs
 * something to be a retry *of*. "The September journal" is not an identity; run
 * the date arithmetic twice and QuickBooks has two entries and a doubled cost.
 */

export type CogsBatchSummary = {
  id: string
  periodStart: string
  periodEnd: string
  status: 'DRAFT' | 'POSTED' | 'VOIDED'
  salesCogs: string
  returnCogs: string
  totalCogs: string
  saleCount: number
  returnCount: number
  sourceHash: string
  postedAt: Date | null
  /** The QuickBooks journal entry, once it exists. */
  externalId: string | null
  syncStatus: string | null
}

type Totals = {
  salesCogs: string
  returnCogs: string
  totalCogs: string
  saleCount: number
  returnCount: number
}

/**
 * The figures for a period, from posted documents only.
 *
 * Deliberately the same predicates the gross-profit report uses: COMPLETED
 * sales, non-VOIDED credits, by the document's own timestamp. A voided sale is
 * not cost that was later reversed — it is a document that never counted, and
 * its compensating ledger entries already removed its effect (docs/02 §A4).
 */
export async function computeCogs(
  ctx: AuthContext,
  period: { from: string; to: string },
): Promise<Totals> {
  const zone = ctx.organization.timezone
  const fromDate = startOfLocalDate(period.from, zone)
  const toDate = endOfLocalDate(period.to, zone)
  const prisma = db(ctx)

  const [sales] = await prisma.$queryRaw<{ cogs: string; documents: bigint }[]>(Prisma.sql`
    SELECT COALESCE(SUM(i.unit_cost_at_sale * i.base_quantity), 0)::text AS cogs,
           COUNT(DISTINCT s.id)::bigint AS documents
      FROM sale_item i
      JOIN sale s ON s.id = i.sale_id
     WHERE s.organization_id = ${ctx.organizationId}
       AND s.status = 'COMPLETED'
       AND s.occurred_at >= ${fromDate}
       AND s.occurred_at <= ${toDate}
  `)

  const [credits] = await prisma.$queryRaw<{ cogs: string; documents: bigint }[]>(Prisma.sql`
    SELECT COALESCE(SUM(ci.unit_cost_at_sale * ci.base_quantity), 0)::text AS cogs,
           COUNT(DISTINCT cm.id)::bigint AS documents
      FROM credit_memo_item ci
      JOIN credit_memo cm ON cm.id = ci.credit_memo_id
     WHERE cm.organization_id = ${ctx.organizationId}
       AND cm.status <> 'VOIDED'
       AND cm.issued_at >= ${fromDate}
       AND cm.issued_at <= ${toDate}
  `)

  const salesCogs = m(sales?.cogs ?? 0)
  const returnCogs = m(credits?.cogs ?? 0)

  return {
    salesCogs: toAmountString(salesCogs),
    returnCogs: toAmountString(returnCogs),
    totalCogs: toAmountString(salesCogs.minus(returnCogs)),
    saleCount: Number(sales?.documents ?? 0),
    returnCount: Number(credits?.documents ?? 0),
  }
}

/**
 * A fingerprint of the figures, so a recomputation that disagrees is visible.
 *
 * Posted history does not move, so a frozen batch recomputed later must hash the
 * same. If it does not, something edited a closed period and somebody needs to
 * know — which is exactly the failure mode a "just recompute it" design hides.
 */
function hashOf(period: { from: string; to: string }, totals: Totals): string {
  return createHash('sha256')
    .update(
      [period.from, period.to, totals.salesCogs, totals.returnCogs, totals.totalCogs, totals.saleCount, totals.returnCount].join(
        '|',
      ),
    )
    .digest('hex')
}

/** Creates or refreshes the draft batch for a period. */
export async function prepareCogsBatch(
  ctx: AuthContext,
  period: { from: string; to: string },
): Promise<CogsBatchSummary> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  if (period.to < period.from) throw conflict('That period ends before it starts.')

  const totals = await computeCogs(ctx, period)
  const sourceHash = hashOf(period, totals)
  const periodStart = dateOnly(period.from)
  const periodEnd = dateOnly(period.to)

  const existing = await prisma.cogsJournalBatch.findFirst({
    where: { periodStart, periodEnd },
    select: { id: true, status: true, sourceHash: true },
  })

  if (existing && existing.status !== 'DRAFT') {
    // A posted batch is history. Recomputing it would restate a period
    // QuickBooks already has (rule 6).
    throw conflict(
      `The ${period.from} to ${period.to} COGS journal has already been posted. ` +
        'Void it and create a new one if the period really has to be restated.',
    )
  }

  const batch = await prisma.cogsJournalBatch.upsert({
    where: {
      organizationId_periodStart_periodEnd: {
        organizationId: ctx.organizationId,
        periodStart,
        periodEnd,
      },
    },
    create: {
      organizationId: ctx.organizationId,
      periodStart,
      periodEnd,
      status: 'DRAFT',
      createdByUserId: ctx.userId,
      sourceHash,
      ...totals,
    },
    update: { sourceHash, ...totals },
    select: { id: true },
  })

  return (await getCogsBatch(ctx, batch.id))!
}

/**
 * Freezes a batch and queues it.
 *
 * After this the figures never change. A correction is a new batch for a new
 * period or a void and a replacement — never an edit, for the same reason a
 * posted sale is never edited (rule 7).
 */
export async function postCogsBatch(ctx: AuthContext, batchId: string): Promise<CogsBatchSummary> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const batch = await prisma.cogsJournalBatch.findFirst({ where: { id: batchId } })
  if (!batch) throw notFound('That COGS journal')
  if (batch.status === 'POSTED') throw conflict('That COGS journal has already been posted.')
  if (batch.status === 'VOIDED') throw conflict('That COGS journal was voided.')

  if (m(batch.totalCogs).isZero()) {
    throw conflict('That period has no cost to post. QuickBooks does not need an empty journal.')
  }

  await prisma.$transaction(async (tx) => {
    await tx.cogsJournalBatch.update({
      where: { id: batchId },
      data: { status: 'POSTED', postedAt: new Date() },
    })

    await enqueueIfConnected(tx, ctx.organizationId, {
      entityType: 'CogsJournalBatch',
      localId: batchId,
      operation: 'CREATE',
    })

    await writeAudit(tx, ctx, {
      action: 'cogs.posted',
      entityType: 'CogsJournalBatch',
      entityId: batchId,
      after: {
        period: `${batch.periodStart.toISOString().slice(0, 10)} to ${batch.periodEnd.toISOString().slice(0, 10)}`,
        salesCogs: toAmountString(batch.salesCogs),
        returnCogs: toAmountString(batch.returnCogs),
        totalCogs: toAmountString(batch.totalCogs),
        saleCount: batch.saleCount,
        returnCount: batch.returnCount,
      },
    })
  })

  return (await getCogsBatch(ctx, batchId))!
}

export async function voidCogsBatch(
  ctx: AuthContext,
  batchId: string,
  reason: string,
): Promise<void> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const batch = await prisma.cogsJournalBatch.findFirst({ where: { id: batchId } })
  if (!batch) throw notFound('That COGS journal')
  if (batch.status === 'VOIDED') throw conflict('That COGS journal was already voided.')

  await prisma.$transaction(async (tx) => {
    // Never deleted here, and never deleted over there either: QuickBooks has
    // no void for a journal entry, so the reversal is a second, opposite entry
    // and both halves stay readable (docs/08 §17).
    await tx.cogsJournalBatch.update({ where: { id: batchId }, data: { status: 'VOIDED' } })

    await enqueueVoidIfConnected(tx, ctx.organizationId, {
      entityType: 'CogsJournalBatch',
      localId: batchId,
    })
    await writeAudit(tx, ctx, {
      action: 'cogs.voided',
      entityType: 'CogsJournalBatch',
      entityId: batchId,
      after: { reason, totalCogs: toAmountString(batch.totalCogs) },
    })
  })
}

export async function getCogsBatch(ctx: AuthContext, batchId: string): Promise<CogsBatchSummary | null> {
  const prisma = db(ctx)
  const batch = await prisma.cogsJournalBatch.findFirst({ where: { id: batchId } })
  if (!batch) return null

  const mapping = await prisma.externalMapping.findFirst({
    where: { provider: 'QUICKBOOKS_ONLINE', entityType: 'CogsJournalBatch', localId: batchId },
    select: { externalId: true, status: true },
  })

  return {
    id: batch.id,
    periodStart: batch.periodStart.toISOString().slice(0, 10),
    periodEnd: batch.periodEnd.toISOString().slice(0, 10),
    status: batch.status,
    salesCogs: toAmountString(batch.salesCogs),
    returnCogs: toAmountString(batch.returnCogs),
    totalCogs: toAmountString(batch.totalCogs),
    saleCount: batch.saleCount,
    returnCount: batch.returnCount,
    sourceHash: batch.sourceHash,
    postedAt: batch.postedAt,
    externalId: mapping?.externalId ?? null,
    syncStatus: mapping?.status ?? null,
  }
}

export async function listCogsBatches(ctx: AuthContext, limit = 24): Promise<CogsBatchSummary[]> {
  requirePermission(ctx, 'org:manage_integrations')
  const prisma = db(ctx)

  const batches = await prisma.cogsJournalBatch.findMany({
    orderBy: { periodStart: 'desc' },
    take: limit,
    select: { id: true },
  })

  const summaries = await Promise.all(batches.map((batch) => getCogsBatch(ctx, batch.id)))
  return summaries.filter((entry): entry is CogsBatchSummary => entry !== null)
}
