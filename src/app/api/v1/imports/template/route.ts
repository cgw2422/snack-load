import { z } from 'zod'
import type { ImportType } from '@/generated/prisma/enums'
import { buildTemplateCsv } from '@/server/services/import.service'
import { requirePermission } from '@/server/auth/context'
import { apiError, csvResponse, requireApiAuth } from '@/app/api/v1/_lib/handler'

const querySchema = z.object({ type: z.enum(['PRODUCTS', 'CUSTOMERS']) })

export async function GET(request: Request) {
  try {
    const ctx = await requireApiAuth()
    const { type } = querySchema.parse({
      type: new URL(request.url).searchParams.get('type'),
    })

    requirePermission(ctx, type === 'PRODUCTS' ? 'product:import' : 'customer:import')

    return csvResponse(
      `﻿${buildTemplateCsv(type as ImportType)}`,
      `snackload-${type.toLowerCase()}-template.csv`,
    )
  } catch (error) {
    return apiError(error)
  }
}
