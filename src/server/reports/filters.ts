import { Prisma } from '@/generated/prisma/client'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { endOfLocalDate, localDateString, startOfLocalDate } from '@/lib/dates'
import type { ReportFilters } from './types'

/**
 * Shared filter plumbing.
 *
 * Every report answers a question about a window of time, and a distributor's
 * day starts and ends in their own timezone, not the server's. `from` and `to`
 * are calendar days; they become instants here, once, so no report has to get
 * it right on its own.
 */

export type ResolvedRange = { fromDate: Date; toDate: Date; from: string; to: string }

/** Defaults to the last 30 days, which is the window somebody means by "lately". */
export function resolveRange(filters: ReportFilters, timeZone: string): ResolvedRange {
  const today = localDateString(new Date(), timeZone)
  const to = filters.to || today
  const from =
    filters.from ||
    localDateString(new Date(Date.now() - 29 * 86_400_000), timeZone)

  return {
    from,
    to,
    // The named day, not "the local day containing UTC midnight of that day".
    fromDate: startOfLocalDate(from, timeZone),
    toDate: endOfLocalDate(to, timeZone),
  }
}

/**
 * The SQL predicate for "sales that actually happened in this window".
 *
 * VOIDED sales are excluded everywhere. A voided sale is not revenue that was
 * later refunded — it is a document that was cancelled, and its compensating
 * ledger entries already removed its effect on stock and AR (docs/02 §A4).
 * Counting it would double-count the correction.
 */
export function postedSalesPredicate(
  organizationId: string,
  range: ResolvedRange,
  filters: ReportFilters,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`s.organization_id = ${organizationId}`,
    Prisma.sql`s.status = 'COMPLETED'`,
    Prisma.sql`s.occurred_at >= ${range.fromDate}`,
    Prisma.sql`s.occurred_at <= ${range.toDate}`,
  ]

  if (filters.customerId) clauses.push(Prisma.sql`s.customer_id = ${filters.customerId}`)
  if (filters.runnerUserId) clauses.push(Prisma.sql`s.sold_by_user_id = ${filters.runnerUserId}`)
  if (filters.routeTemplateId) {
    clauses.push(Prisma.sql`
      s.route_id IN (
        SELECT r.id FROM route r WHERE r.route_template_id = ${filters.routeTemplateId}
      )`)
  }

  return Prisma.join(clauses, ' AND ')
}

/** Item-level narrowing, applied on top of the sale predicate. */
export function itemPredicate(filters: ReportFilters): Prisma.Sql {
  const clauses: Prisma.Sql[] = []
  if (filters.productId) clauses.push(Prisma.sql`i.product_id = ${filters.productId}`)
  if (filters.categoryId) {
    clauses.push(Prisma.sql`
      i.product_id IN (SELECT p.id FROM product p WHERE p.category_id = ${filters.categoryId})`)
  }
  return clauses.length > 0
    ? Prisma.sql`AND ${Prisma.join(clauses, ' AND ')}`
    : Prisma.empty
}

/**
 * Turns the filters into the sentence printed at the top of an export, so a
 * spreadsheet emailed to an accountant says what it is a report of.
 */
export async function describeFilters(
  ctx: AuthContext,
  filters: ReportFilters,
  range: ResolvedRange,
): Promise<string> {
  const parts: string[] = [`${range.from} to ${range.to}`]
  const prisma = db(ctx)

  if (filters.routeTemplateId) {
    const route = await prisma.routeTemplate.findFirst({
      where: { id: filters.routeTemplateId },
      select: { name: true },
    })
    parts.push(`route ${route?.name ?? 'unknown'}`)
  }
  if (filters.runnerUserId) {
    const membership = await prisma.membership.findFirst({
      where: { userId: filters.runnerUserId },
      select: { user: { select: { firstName: true, lastName: true } } },
    })
    parts.push(
      `runner ${membership ? `${membership.user.firstName} ${membership.user.lastName}`.trim() : 'unknown'}`,
    )
  }
  if (filters.customerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: filters.customerId },
      select: { name: true },
    })
    parts.push(`store ${customer?.name ?? 'unknown'}`)
  }
  if (filters.productId) {
    const product = await prisma.product.findFirst({
      where: { id: filters.productId },
      select: { name: true },
    })
    parts.push(`product ${product?.name ?? 'unknown'}`)
  }
  if (filters.categoryId) {
    const category = await prisma.productCategory.findFirst({
      where: { id: filters.categoryId },
      select: { name: true },
    })
    parts.push(`category ${category?.name ?? 'unknown'}`)
  }

  return parts.join(' · ')
}

/**
 * Raw SQL bypasses the tenant extension, so every query in this folder passes
 * `organizationId` by hand and is reviewed as security-sensitive (docs/04 §5).
 * This wrapper exists so that is a single, greppable call rather than a habit.
 */
export function reportQuery<T>(ctx: AuthContext, sql: Prisma.Sql): Promise<T[]> {
  return db(ctx).$queryRaw<T[]>(sql)
}

/**
 * The matching predicate for credits issued in the window (spec §14).
 *
 * Returns are never hidden by presenting an already-netted number, so every
 * report that shows sales shows the credits beside them. A voided credit memo
 * is excluded for the same reason a voided sale is: its effects were unwound,
 * and counting it would double-count the correction.
 */
export function postedCreditsPredicate(
  organizationId: string,
  range: ResolvedRange,
  filters: ReportFilters,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`cm.organization_id = ${organizationId}`,
    Prisma.sql`cm.status <> 'VOIDED'`,
    Prisma.sql`cm.issued_at >= ${range.fromDate}`,
    Prisma.sql`cm.issued_at <= ${range.toDate}`,
  ]

  if (filters.customerId) clauses.push(Prisma.sql`cm.customer_id = ${filters.customerId}`)
  // A credit belongs to the route and runner of the sale it reverses, so the
  // same filters narrow both sides of a gross/returns/net comparison.
  if (filters.runnerUserId) {
    clauses.push(Prisma.sql`
      cm.sale_id IN (SELECT s2.id FROM sale s2 WHERE s2.sold_by_user_id = ${filters.runnerUserId})`)
  }
  if (filters.routeTemplateId) {
    clauses.push(Prisma.sql`
      cm.sale_id IN (
        SELECT s2.id FROM sale s2
          JOIN route r2 ON r2.id = s2.route_id
         WHERE r2.route_template_id = ${filters.routeTemplateId}
      )`)
  }

  return Prisma.join(clauses, ' AND ')
}

/** Item-level narrowing for credit lines. */
export function creditItemPredicate(filters: ReportFilters): Prisma.Sql {
  const clauses: Prisma.Sql[] = []
  if (filters.productId) clauses.push(Prisma.sql`ci.product_id = ${filters.productId}`)
  if (filters.categoryId) {
    clauses.push(Prisma.sql`
      ci.product_id IN (SELECT p.id FROM product p WHERE p.category_id = ${filters.categoryId})`)
  }
  return clauses.length > 0 ? Prisma.sql`AND ${Prisma.join(clauses, ' AND ')}` : Prisma.empty
}
