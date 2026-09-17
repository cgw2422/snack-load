import type { AuthContext } from '@/server/auth/context'
import { can, requirePermission } from '@/server/auth/context'
import { notFound } from '@/lib/errors'
import { runSalesReport } from './sales.report'
import { runGrossProfitReport } from './grossProfit.report'
import { runCustomersReport } from './customers.report'
import { runInventoryReport } from './inventory.report'
import { runRoutesReport, runRunnersReport } from './routes.report'
import { runAgingReport } from './aging.report'
import type { ReportDefinition, ReportFilters, ReportKey, ReportResult } from './types'

export type { ReportColumn, ReportFilters, ReportKey, ReportResult, ReportRow } from './types'

/**
 * The report registry.
 *
 * One table drives the reports centre, the filter controls, the permission
 * check and every export route, so adding a report is a module plus an entry
 * here rather than a page, three routes and a menu item that drift apart.
 */
export const REPORTS: Record<ReportKey, ReportDefinition> = {
  sales: {
    key: 'sales',
    title: 'Sales',
    summary: 'What went out the door, by day, store, product, brand, route or runner.',
    permission: 'report:read',
    supports: {
      route: true,
      runner: true,
      customer: true,
      product: true,
      category: true,
      groupBy: [
        { key: 'day', label: 'Day' },
        { key: 'customer', label: 'Store' },
        { key: 'product', label: 'Product' },
        { key: 'brand', label: 'Brand' },
        { key: 'route', label: 'Route' },
        { key: 'runner', label: 'Runner' },
      ],
    },
  },
  'gross-profit': {
    key: 'gross-profit',
    title: 'Gross profit',
    summary: 'Net sales less cost of goods. Not net profit — nothing operational is deducted.',
    permission: 'report:financial',
    supports: {
      route: true,
      runner: true,
      customer: true,
      product: true,
      category: true,
      groupBy: [
        { key: 'product', label: 'Product' },
        { key: 'brand', label: 'Brand' },
        { key: 'category', label: 'Category' },
        { key: 'customer', label: 'Store' },
        { key: 'route', label: 'Route' },
      ],
    },
  },
  customers: {
    key: 'customers',
    title: 'Customers',
    summary: 'Every account against its own recent history, so a quiet decline is visible.',
    permission: 'report:read',
    supports: { customer: true, route: true },
  },
  inventory: {
    key: 'inventory',
    title: 'Inventory',
    summary: 'What you are holding, what it cost, what moved, and what is not moving.',
    permission: 'report:read',
    supports: { product: true, category: true },
  },
  routes: {
    key: 'routes',
    title: 'Routes',
    summary: 'Stops, orders, billed and collected, per route.',
    permission: 'report:read',
    supports: { route: true, runner: true },
  },
  runners: {
    key: 'runners',
    title: 'Runners',
    summary: 'The same numbers by the person who drove them.',
    permission: 'report:read',
    supports: { route: true, runner: true },
  },
  aging: {
    key: 'aging',
    title: 'Receivables aging',
    summary: 'Who owes what, bucketed from the due date rather than the invoice date.',
    permission: 'report:financial',
    supports: { customer: true, route: true },
  },
}

const RUNNERS: Record<ReportKey, (ctx: AuthContext, f: ReportFilters) => Promise<ReportResult>> = {
  sales: runSalesReport,
  'gross-profit': runGrossProfitReport,
  customers: runCustomersReport,
  inventory: runInventoryReport,
  routes: runRoutesReport,
  runners: runRunnersReport,
  aging: runAgingReport,
}

export function isReportKey(value: string): value is ReportKey {
  return value in REPORTS
}

/** The reports this user may open, in the order the centre lists them. */
export function visibleReports(ctx: AuthContext): ReportDefinition[] {
  return Object.values(REPORTS).filter((report) => can(ctx, report.permission))
}

export async function runReport(
  ctx: AuthContext,
  key: string,
  filters: ReportFilters,
): Promise<ReportResult> {
  if (!isReportKey(key)) throw notFound('That report')

  // Cost, margin and receivables are held tighter than volume: a warehouse user
  // may see what moved without seeing what it earns (docs/04 §3).
  requirePermission(ctx, REPORTS[key].permission)

  return RUNNERS[key](ctx, filters)
}
