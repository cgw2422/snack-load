import { runReport } from '@/server/reports'
import {
  CONTENT_TYPES,
  exportFileName,
  toCsv,
  toPdf,
  toXlsx,
  type ExportFormat,
} from '@/server/reports/export'
import { apiError, fileResponse, requireApiAuth } from '@/app/api/v1/_lib/handler'
import { can } from '@/server/auth/context'
import { AppError } from '@/lib/errors'

/** exceljs and pdf-lib both need Node. */
export const runtime = 'nodejs'

const FORMATS = new Set<ExportFormat>(['csv', 'xlsx', 'pdf'])

export async function GET(request: Request, context: RouteContext<'/api/v1/reports/[key]/export'>) {
  try {
    const ctx = await requireApiAuth()
    if (!can(ctx, 'report:export')) {
      throw new AppError('FORBIDDEN', 'You do not have permission to export reports.')
    }

    const { key } = await context.params
    const url = new URL(request.url)

    const format = (url.searchParams.get('format') ?? 'csv') as ExportFormat
    if (!FORMATS.has(format)) {
      throw new AppError('VALIDATION_FAILED', 'Export format must be csv, xlsx or pdf.')
    }

    // runReport enforces the report's own permission and scopes every query to
    // the session's organization.
    const report = await runReport(ctx, key, {
      from: url.searchParams.get('from') ?? '',
      to: url.searchParams.get('to') ?? '',
      routeTemplateId: url.searchParams.get('routeTemplateId') ?? undefined,
      runnerUserId: url.searchParams.get('runnerUserId') ?? undefined,
      customerId: url.searchParams.get('customerId') ?? undefined,
      productId: url.searchParams.get('productId') ?? undefined,
      categoryId: url.searchParams.get('categoryId') ?? undefined,
      groupBy: url.searchParams.get('groupBy') ?? undefined,
    })

    const body =
      format === 'csv'
        ? new TextEncoder().encode(toCsv(report))
        : format === 'xlsx'
          ? await toXlsx(report)
          : await toPdf(report)

    return fileResponse(body, exportFileName(report, format), CONTENT_TYPES[format])
  } catch (error) {
    return apiError(error)
  }
}
