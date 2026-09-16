import { buildErrorCsv } from '@/server/services/import.service'
import { apiError, csvResponse, requireApiAuth } from '@/app/api/v1/_lib/handler'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiAuth()
    const { id } = await params
    // buildErrorCsv resolves the job through the tenant-scoped client, so an id
    // belonging to another company simply is not found.
    return csvResponse(`﻿${await buildErrorCsv(ctx, id)}`, `import-${id}-problems.csv`)
  } catch (error) {
    return apiError(error)
  }
}
