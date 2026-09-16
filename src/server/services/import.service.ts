import { Prisma } from '@/generated/prisma/client'
import type { ImportMatchKey, ImportMode, ImportType } from '@/generated/prisma/enums'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { AppError, conflict, notFound } from '@/lib/errors'
import { m, round6 } from '@/server/domain/money'
import { fieldsFor, suggestMapping, type ImportField } from '@/server/import/fields'
import { MAX_IMPORT_ROWS, parseSpreadsheet, toCsv } from '@/server/import/parse'
import {
  emptyIndex,
  validateRow,
  type ExistingIndex,
  type RowMessage,
  type RowVerdict,
} from '@/server/import/validate'
import { nextDocumentNumber, postInventoryTransaction } from './inventory.service'
import { writeAudit } from './audit.service'

/**
 * The import state machine (docs/03 §5).
 *
 *   UPLOAD ──► MAPPING ──► VALIDATING ──► PREVIEW ──► IMPORTING ──► COMPLETED
 *
 * Staged and resumable, because a 4,000-row spreadsheet is not something to hold
 * in memory and hope. Rows persist after the job so "where did this price come
 * from" stays answerable months later.
 */

const COMMIT_CHUNK = 200

export type ImportSummary = {
  id: string
  type: ImportType
  status: string
  mode: ImportMode
  matchKey: ImportMatchKey
  fileName: string
  totalRows: number
  readyRows: number
  warningRows: number
  errorRows: number
  importedRows: number
  skippedRows: number
  createdAt: string
  completedAt: string | null
  createdByName: string | null
}

export type ImportPreview = ImportSummary & {
  headers: string[]
  mapping: Record<string, string>
  fields: ImportField[]
  /** Distinct reference values needing a decision, e.g. route "Tuesday". */
  unresolved: { kind: string; value: string; suggestions: { id: string; label: string }[] }[]
  rows: {
    id: string
    rowNumber: number
    status: string
    action: string
    messages: RowMessage[]
    values: Record<string, unknown>
    raw: Record<string, string>
  }[]
}

/** Step 1 — take the file, find the headers, suggest a mapping. */
export async function createImportJob(
  ctx: AuthContext,
  input: { type: ImportType; fileName: string; bytes: Uint8Array },
): Promise<{ jobId: string; headers: string[]; mapping: Record<string, string>; rowCount: number }> {
  requirePermission(ctx, input.type === 'PRODUCTS' ? 'product:import' : 'customer:import')

  const sheet = await parseSpreadsheet(input.fileName, input.bytes)
  if (sheet.rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'That file has headings but no rows.')
  }

  const fields = fieldsFor(input.type)
  const mapping = suggestMapping(sheet.headers, fields)

  const job = await db(ctx).importJob.create({
    data: {
      organizationId: ctx.organizationId,
      type: input.type,
      fileName: input.fileName,
      fileSize: input.bytes.byteLength,
      status: 'MAPPING',
      mode: 'UPSERT',
      matchKey: input.type === 'PRODUCTS' ? 'SKU' : 'ACCOUNT_NUMBER',
      columnMapJson: mapping,
      totalRows: sheet.rows.length,
      createdByUserId: ctx.userId,
      summaryJson: {
        headers: sheet.headers,
        headerRow: sheet.headerRow,
        truncated: sheet.truncated,
      },
      // Raw rows are stored now so the job survives a refresh, a lost connection
      // or a browser crash between mapping and commit.
      rows: {
        create: sheet.rows.map((raw, index) => ({
          organizationId: ctx.organizationId,
          rowNumber: index + 1,
          rawJson: raw,
        })),
      },
    },
    select: { id: true },
  })

  if (sheet.truncated) {
    await db(ctx).importRow.updateMany({
      where: { importJobId: job.id, rowNumber: MAX_IMPORT_ROWS },
      data: {
        messagesJson: [
          {
            level: 'warning',
            field: null,
            message: `Only the first ${MAX_IMPORT_ROWS.toLocaleString()} rows were read.`,
          },
        ],
      },
    })
  }

  return {
    jobId: job.id,
    headers: sheet.headers,
    mapping,
    rowCount: sheet.rows.length,
  }
}

/** Step 2 — apply the mapping and validate every row. */
export async function validateImportJob(
  ctx: AuthContext,
  jobId: string,
  settings: {
    mapping: Record<string, string>
    mode: ImportMode
    matchKey: ImportMatchKey
    resolvedReferences?: Record<string, string>
  },
): Promise<ImportPreview> {
  const job = await requireJob(ctx, jobId)
  requirePermission(ctx, job.type === 'PRODUCTS' ? 'product:import' : 'customer:import')

  const prisma = db(ctx)
  const rows = await prisma.importRow.findMany({
    where: { importJobId: jobId },
    orderBy: { rowNumber: 'asc' },
    select: { id: true, rowNumber: true, rawJson: true },
  })

  const existing = await buildExistingIndex(ctx, job.type)
  const knownReferences = await buildKnownReferences(ctx, job.type)
  const seen = { sku: new Set<string>(), upc: new Set<string>(), accountNumber: new Set<string>() }

  const verdicts: (RowVerdict & { id: string; rowNumber: number })[] = []
  const references = new Map<string, Set<string>>()

  for (const row of rows) {
    const raw = row.rawJson as Record<string, string>
    const verdict = validateRow(raw, {
      type: job.type,
      mode: settings.mode,
      matchKey: settings.matchKey,
      mapping: settings.mapping,
      existing,
      seen,
      knownReferences,
      resolvedReferences: settings.resolvedReferences,
    })

    // Claim this row's natural keys so a later duplicate in the same file is
    // reported against the later row, not the first legitimate one.
    for (const key of ['sku', 'upc', 'accountNumber'] as const) {
      const value = verdict.normalized[key]
      if (typeof value === 'string' && value) seen[key].add(value.toLowerCase())
    }

    for (const [kind, value] of Object.entries(verdict.references)) {
      if (!references.has(kind)) references.set(kind, new Set())
      references.get(kind)!.add(value)
    }

    verdicts.push({ ...verdict, id: row.id, rowNumber: row.rowNumber })
  }

  const counts = {
    ready: verdicts.filter((v) => v.status === 'READY').length,
    warning: verdicts.filter((v) => v.status === 'WARNING').length,
    error: verdicts.filter((v) => v.status === 'ERROR').length,
  }

  const unresolved = await resolveReferenceOptions(
    ctx,
    job.type,
    [...references.entries()],
    { ...(job.referenceMapJson as Record<string, string>), ...(settings.resolvedReferences ?? {}) },
    knownReferences,
  )

  await prisma.$transaction(async (tx) => {
    for (const verdict of verdicts) {
      await tx.importRow.update({
        where: { id: verdict.id },
        data: {
          status: verdict.status,
          action: verdict.action,
          normalizedJson: verdict.normalized as Prisma.InputJsonValue,
          messagesJson: verdict.messages as unknown as Prisma.InputJsonValue,
          targetId: verdict.targetId,
          targetType: job.type === 'PRODUCTS' ? 'Product' : 'Customer',
        },
      })
    }

    await tx.importJob.update({
      where: { id: jobId },
      data: {
        status: 'PREVIEW',
        mode: settings.mode,
        matchKey: settings.matchKey,
        columnMapJson: settings.mapping,
        referenceMapJson: settings.resolvedReferences ?? {},
        readyRows: counts.ready,
        warningRows: counts.warning,
        errorRows: counts.error,
        summaryJson: {
          ...((job.summaryJson ?? {}) as Record<string, unknown>),
          unresolved,
        } as Prisma.InputJsonValue,
      },
    })
  })

  return getImportPreview(ctx, jobId)
}

/** Step 3 — commit. Chunked and resumable; progress lives on the rows. */
export async function commitImportJob(
  ctx: AuthContext,
  jobId: string,
  options: { skipWarnings?: boolean } = {},
): Promise<{ imported: number; skipped: number; failed: number }> {
  const job = await requireJob(ctx, jobId)
  requirePermission(ctx, job.type === 'PRODUCTS' ? 'product:import' : 'customer:import')

  if (job.status === 'COMPLETED') throw conflict('That import has already run.')
  if (job.status === 'IMPORTING') throw conflict('That import is already running.')

  const prisma = db(ctx)
  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: 'IMPORTING', startedAt: new Date() },
  })

  const statuses = options.skipWarnings ? ['READY'] : ['READY', 'WARNING']

  let imported = 0
  let failed = 0

  for (;;) {
    const batch = await prisma.importRow.findMany({
      where: {
        importJobId: jobId,
        status: { in: statuses as ('READY' | 'WARNING')[] },
        action: { in: ['CREATE', 'UPDATE'] },
      },
      orderBy: { rowNumber: 'asc' },
      take: COMMIT_CHUNK,
      select: { id: true, rowNumber: true, normalizedJson: true, action: true, targetId: true },
    })
    if (batch.length === 0) break

    for (const row of batch) {
      const values = row.normalizedJson as Record<string, unknown>
      try {
        const targetId =
          job.type === 'PRODUCTS'
            ? await upsertProduct(ctx, values, row.targetId)
            : await upsertCustomer(ctx, values, row.targetId, job.referenceMapJson as Record<string, string>)

        await prisma.importRow.update({
          where: { id: row.id },
          data: { status: 'IMPORTED', targetId },
        })
        imported += 1
      } catch (error) {
        // One bad row must not abandon the other 3,999.
        const message = error instanceof AppError ? error.message : 'Could not import this row'
        await prisma.importRow.update({
          where: { id: row.id },
          data: {
            status: 'ERROR',
            action: 'SKIP',
            messagesJson: [{ level: 'error', field: null, message }] as unknown as Prisma.InputJsonValue,
          },
        })
        failed += 1
      }
    }
  }

  const skipped = await prisma.importRow.count({
    where: { importJobId: jobId, status: { in: ['ERROR', 'SKIPPED'] } },
  })

  await prisma.$transaction(async (tx) => {
    await tx.importJob.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        importedRows: imported,
        skippedRows: skipped,
        errorRows: failed,
      },
    })
    await writeAudit(tx, ctx, {
      action: 'import.committed',
      entityType: 'ImportJob',
      entityId: jobId,
      after: { type: job.type, mode: job.mode, imported, skipped, failed, fileName: job.fileName },
    })
  })

  return { imported, skipped, failed }
}

export async function cancelImportJob(ctx: AuthContext, jobId: string): Promise<void> {
  const job = await requireJob(ctx, jobId)
  if (job.status === 'COMPLETED') throw conflict('That import has already run.')
  await db(ctx).importJob.update({ where: { id: jobId }, data: { status: 'CANCELLED' } })
}

/** Inline fixes: re-validate just the edited row rather than the whole file. */
export async function patchImportRow(
  ctx: AuthContext,
  jobId: string,
  rowId: string,
  edits: Record<string, string>,
): Promise<void> {
  const job = await requireJob(ctx, jobId)
  const prisma = db(ctx)

  const row = await prisma.importRow.findFirst({
    where: { id: rowId, importJobId: jobId },
    select: { rawJson: true },
  })
  if (!row) throw notFound('That row')

  const raw = { ...(row.rawJson as Record<string, string>), ...edits }
  const existing = await buildExistingIndex(ctx, job.type)

  const verdict = validateRow(raw, {
    type: job.type,
    mode: job.mode,
    matchKey: job.matchKey,
    mapping: job.columnMapJson as Record<string, string>,
    existing,
    knownReferences: await buildKnownReferences(ctx, job.type),
    // The file-level duplicate check does not apply to a single re-validation;
    // the row is being compared against what is in the database.
    seen: { sku: new Set(), upc: new Set(), accountNumber: new Set() },
    resolvedReferences: job.referenceMapJson as Record<string, string>,
  })

  await prisma.importRow.update({
    where: { id: rowId },
    data: {
      rawJson: raw,
      status: verdict.status,
      action: verdict.action,
      normalizedJson: verdict.normalized as Prisma.InputJsonValue,
      messagesJson: verdict.messages as unknown as Prisma.InputJsonValue,
      targetId: verdict.targetId,
    },
  })

  await refreshCounts(ctx, jobId)
}

export async function getImportPreview(
  ctx: AuthContext,
  jobId: string,
): Promise<ImportPreview> {
  const job = await requireJob(ctx, jobId)
  const prisma = db(ctx)

  const rows = await prisma.importRow.findMany({
    where: { importJobId: jobId },
    orderBy: [{ status: 'asc' }, { rowNumber: 'asc' }],
    take: 200,
    select: {
      id: true, rowNumber: true, status: true, action: true,
      messagesJson: true, normalizedJson: true, rawJson: true,
    },
  })

  const summary = (job.summaryJson ?? {}) as {
    headers?: string[]
    unresolved?: ImportPreview['unresolved']
  }

  return {
    ...toSummary(job),
    headers: summary.headers ?? [],
    mapping: job.columnMapJson as Record<string, string>,
    fields: fieldsFor(job.type),
    unresolved: summary.unresolved ?? [],
    rows: rows.map((row) => ({
      id: row.id,
      rowNumber: row.rowNumber,
      status: row.status,
      action: row.action,
      messages: (row.messagesJson ?? []) as unknown as RowMessage[],
      values: (row.normalizedJson ?? {}) as Record<string, unknown>,
      raw: row.rawJson as Record<string, string>,
    })),
  }
}

export async function listImportJobs(ctx: AuthContext): Promise<ImportSummary[]> {
  requirePermission(ctx, 'product:read')
  const jobs = await db(ctx).importJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: 25,
    include: { createdBy: { select: { firstName: true, lastName: true } } },
  })
  return jobs.map(toSummary)
}

/** The error CSV a user downloads to fix their file and re-upload it. */
export async function buildErrorCsv(ctx: AuthContext, jobId: string): Promise<string> {
  const job = await requireJob(ctx, jobId)
  const rows = await db(ctx).importRow.findMany({
    where: { importJobId: jobId, status: { in: ['ERROR', 'WARNING'] } },
    orderBy: { rowNumber: 'asc' },
    select: { rowNumber: true, rawJson: true, messagesJson: true },
  })

  const summary = (job.summaryJson ?? {}) as { headers?: string[] }
  const headers = summary.headers ?? []

  return toCsv(
    ['Row', 'Problem', ...headers],
    rows.map((row) => {
      const raw = row.rawJson as Record<string, string>
      const messages = (row.messagesJson ?? []) as unknown as RowMessage[]
      return [
        row.rowNumber,
        messages.map((mm) => mm.message).join('; '),
        ...headers.map((h) => raw[h] ?? ''),
      ]
    }),
  )
}

/** The blank template offered alongside the upload control. */
export function buildTemplateCsv(type: ImportType): string {
  const fields = fieldsFor(type)
  const example =
    type === 'PRODUCTS'
      ? ['1001', '757528005207', 'Takis Fuego', 'Barcel', 'Chips', 'Barcel USA', '14.40',
         '19.50', '2.29', '12', 'Bag', '18', '7', '6', 'Yes', 'Yes']
      : ['1001', "Joe's Marathon", 'Marathon', '123 Main St.', '', 'Riverton', 'OH', '44870',
         'Joe Bianchi', '(555) 123-4567', 'joe@example.com', 'Route A', 'Mike', 'Tuesday',
         'Weekly', '07:00-12:00', 'COD', '2500', 'No', '0', 'Back door before 9am', 'Yes']

  return toCsv(fields.map((f) => f.label), [example.slice(0, fields.length)])
}

// ── internals ────────────────────────────────────────────────────────────────

async function requireJob(ctx: AuthContext, jobId: string) {
  const job = await db(ctx).importJob.findFirst({
    where: { id: jobId },
    include: { createdBy: { select: { firstName: true, lastName: true } } },
  })
  if (!job) throw notFound('Import')
  return job
}

type JobRow = Awaited<ReturnType<typeof requireJob>>

function toSummary(job: JobRow): ImportSummary {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    mode: job.mode,
    matchKey: job.matchKey,
    fileName: job.fileName,
    totalRows: job.totalRows,
    readyRows: job.readyRows,
    warningRows: job.warningRows,
    errorRows: job.errorRows,
    importedRows: job.importedRows,
    skippedRows: job.skippedRows,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    createdByName: job.createdBy
      ? `${job.createdBy.firstName} ${job.createdBy.lastName}`.trim()
      : null,
  }
}

async function refreshCounts(ctx: AuthContext, jobId: string): Promise<void> {
  const prisma = db(ctx)
  const grouped = await prisma.importRow.groupBy({
    by: ['status'],
    where: { importJobId: jobId },
    _count: true,
  })
  const count = (status: string) => grouped.find((g) => g.status === status)?._count ?? 0

  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      readyRows: count('READY'),
      warningRows: count('WARNING'),
      errorRows: count('ERROR'),
    },
  })
}

async function buildExistingIndex(
  ctx: AuthContext,
  type: ImportType,
): Promise<ExistingIndex> {
  const prisma = db(ctx)
  const index = emptyIndex()

  if (type === 'PRODUCTS') {
    const products = await prisma.product.findMany({ select: { id: true, sku: true, upc: true } })
    for (const p of products) {
      index.bySku.set(p.sku.toLowerCase(), p.id)
      if (p.upc) index.byUpc.set(p.upc.toLowerCase(), p.id)
    }
  } else {
    const customers = await prisma.customer.findMany({
      select: { id: true, accountNumber: true, name: true },
    })
    for (const c of customers) {
      index.byAccountNumber.set(c.accountNumber.toLowerCase(), c.id)
      index.byName.set(c.name.toLowerCase(), c.id)
    }
  }

  return index
}

/**
 * What this company already has, indexed by the names a spreadsheet might use.
 * Categories and suppliers are absent on purpose: those are created on demand,
 * so an unknown one is not a decision anyone needs to make.
 */
async function buildKnownReferences(
  ctx: AuthContext,
  type: ImportType,
): Promise<Record<string, Record<string, string>>> {
  if (type !== 'CUSTOMERS') return {}
  const prisma = db(ctx)

  const [routes, members] = await Promise.all([
    prisma.routeTemplate.findMany({
      where: { active: true },
      select: { id: true, name: true, code: true },
    }),
    prisma.membership.findMany({
      where: { status: 'ACTIVE' },
      select: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    }),
  ])

  const route: Record<string, string> = {}
  for (const r of routes) {
    route[r.name.toLowerCase()] = r.id
    if (r.code) route[r.code.toLowerCase()] = r.id
  }

  // First names are indexed too, because spreadsheets say "Mike" — but only when
  // exactly one person answers to it. Two Mikes is a decision, not a guess.
  const runner: Record<string, string> = {}
  const firstNameCounts = new Map<string, number>()
  for (const mm of members) {
    const first = mm.user.firstName.toLowerCase()
    firstNameCounts.set(first, (firstNameCounts.get(first) ?? 0) + 1)
  }
  for (const mm of members) {
    const full = `${mm.user.firstName} ${mm.user.lastName}`.trim().toLowerCase()
    runner[full] = mm.user.id
    runner[mm.user.email.toLowerCase()] = mm.user.id
    const first = mm.user.firstName.toLowerCase()
    if (firstNameCounts.get(first) === 1) runner[first] = mm.user.id
  }

  return { route, runner }
}

/**
 * For each distinct route/runner/category/supplier name in the file, offer what
 * it could map to. The user decides; we never silently create a user or a route
 * from a spreadsheet cell (docs/03 §5).
 */
async function resolveReferenceOptions(
  ctx: AuthContext,
  type: ImportType,
  entries: [string, Set<string>][],
  alreadyResolved: Record<string, string>,
  known: Record<string, Record<string, string>>,
): Promise<ImportPreview['unresolved']> {
  const prisma = db(ctx)
  const out: ImportPreview['unresolved'] = []

  for (const [kind, values] of entries) {
    let options: { id: string; label: string }[] = []

    if (kind === 'route') {
      const routes = await prisma.routeTemplate.findMany({
        where: { active: true },
        select: { id: true, name: true, code: true },
        orderBy: { name: 'asc' },
      })
      options = routes.map((r) => ({ id: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }))
    } else if (kind === 'runner') {
      const members = await prisma.membership.findMany({
        where: { status: 'ACTIVE' },
        select: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      })
      options = members.map((mm) => ({
        id: mm.user.id,
        label: `${mm.user.firstName} ${mm.user.lastName}`.trim() || mm.user.email,
      }))
    } else if (kind === 'category') {
      const categories = await prisma.productCategory.findMany({ select: { id: true, name: true } })
      options = categories.map((c) => ({ id: c.id, label: c.name }))
    } else if (kind === 'supplier') {
      const suppliers = await prisma.supplier.findMany({ select: { id: true, name: true } })
      options = suppliers.map((s) => ({ id: s.id, label: s.name }))
    }

    for (const value of values) {
      const lowered = value.toLowerCase()
      if (alreadyResolved?.[`${kind}:${lowered}`]) continue
      // Already matched by name — nobody needs to be asked about it.
      if (known[kind]?.[lowered]) continue

      out.push({ kind, value, suggestions: rank(value, options) })
    }
  }

  void type
  return out
}

function rank(value: string, options: { id: string; label: string }[]) {
  const needle = value.toLowerCase()
  return [...options]
    .sort((a, b) => score(b.label, needle) - score(a.label, needle))
    .slice(0, 6)
}

function score(label: string, needle: string): number {
  const l = label.toLowerCase()
  if (l === needle) return 100
  if (l.startsWith(needle) || needle.startsWith(l)) return 60
  if (l.includes(needle) || needle.includes(l)) return 40
  return 0
}

async function upsertProduct(
  ctx: AuthContext,
  values: Record<string, unknown>,
  targetId: string | null,
): Promise<string> {
  const prisma = db(ctx)
  const caseCost = values.caseCost as string | undefined

  // A cost update with no pack size column must divide by the pack size the
  // product ALREADY has. Falling back to 1 would file a $14.40 case cost as a
  // $14.40 bag cost and inflate COGS twelvefold on every future sale.
  const caseQuantity =
    (values.caseQuantity as number | undefined) ??
    (targetId
      ? ((
          await prisma.productUom.findFirst({
            where: { productId: targetId, code: 'CASE' },
            select: { baseUnitsPerUom: true },
          })
        )?.baseUnitsPerUom ?? null)
      : null)

  // Cost is stored per base unit; a case cost divided by the case factor is how
  // a spreadsheet's "cost" column becomes something the ledger can use.
  const costPerBaseUnit =
    caseCost !== undefined
      ? round6(m(caseCost).dividedBy(caseQuantity && caseQuantity > 0 ? caseQuantity : 1)).toString()
      : undefined

  const categoryId = values.category
    ? await findOrCreateCategory(ctx, values.category as string)
    : undefined
  const supplierId = values.supplier
    ? await findOrCreateSupplier(ctx, values.supplier as string)
    : undefined

  const scalar = definedOnly({
    sku: values.sku as string | undefined,
    upc: values.upc as string | undefined,
    name: values.name as string | undefined,
    brand: values.brand as string | undefined,
    baseUomLabel: values.baseUomLabel as string | undefined,
    categoryId,
    supplierId,
    costPerBaseUnit,
    taxable: values.taxable as boolean | undefined,
    active: values.active as boolean | undefined,
    reorderPointBaseUnits:
      values.reorderCases !== undefined && caseQuantity
        ? (values.reorderCases as number) * caseQuantity
        : undefined,
  })

  if (targetId) {
    // Update mode patches only the columns the file actually carried. A price
    // list must not blank out descriptions it never mentioned.
    await prisma.product.update({ where: { id: targetId }, data: scalar })
    await syncUoms(ctx, targetId, values, values.caseQuantity as number | undefined ?? null)
    return targetId
  }

  const created = await prisma.product.create({
    data: {
      organizationId: ctx.organizationId,
      sku: (values.sku as string) ?? '',
      name: (values.name as string) ?? '',
      ...scalar,
      baseUomLabel: (values.baseUomLabel as string) ?? 'Each',
    },
    select: { id: true },
  })

  await syncUoms(ctx, created.id, values, caseQuantity)
  await applyOpeningStock(ctx, created.id, values, caseQuantity)
  return created.id
}

async function syncUoms(
  ctx: AuthContext,
  productId: string,
  values: Record<string, unknown>,
  caseQuantity: number | null,
): Promise<void> {
  const prisma = db(ctx)
  const unitPrice = values.unitPrice as string | undefined
  const casePrice = values.casePrice as string | undefined
  const label = (values.baseUomLabel as string | undefined) ?? 'Each'

  // A price-list update carries no pack size — the product already knows it.
  // Without this fallback a "SKU, Price" file would silently fail to reprice
  // the case, which is the single most common update anyone will run.
  const existingCase = caseQuantity
    ? null
    : await prisma.productUom.findFirst({
        where: { productId, code: 'CASE' },
        select: { baseUnitsPerUom: true },
      })
  const effectiveCaseQuantity = caseQuantity ?? existingCase?.baseUnitsPerUom ?? null

  await prisma.productUom.upsert({
    where: { productId_code: { productId, code: 'EACH' } },
    create: {
      organizationId: ctx.organizationId,
      productId,
      code: 'EACH',
      label,
      baseUnitsPerUom: 1,
      price: unitPrice ?? '0',
      isBase: true,
      isDefaultSaleUom: !effectiveCaseQuantity,
      sortOrder: 0,
    },
    update: definedOnly({ label, price: unitPrice }),
  })

  if (effectiveCaseQuantity && effectiveCaseQuantity > 1) {
    await prisma.productUom.upsert({
      where: { productId_code: { productId, code: 'CASE' } },
      create: {
        organizationId: ctx.organizationId,
        productId,
        code: 'CASE',
        label: 'Case',
        baseUnitsPerUom: effectiveCaseQuantity,
        price: casePrice ?? '0',
        barcode: (values.upc as string | undefined) ?? null,
        isDefaultSaleUom: true,
        sortOrder: 1,
      },
      update: definedOnly({ baseUnitsPerUom: caseQuantity ?? undefined, price: casePrice }),
    })
  }
}

/**
 * Opening stock arrives as a supplier receipt through the ledger, not as a
 * balance written directly — so day one has the same audit trail as day two
 * (docs/02 §L1).
 */
async function applyOpeningStock(
  ctx: AuthContext,
  productId: string,
  values: Record<string, unknown>,
  caseQuantity: number | null,
): Promise<void> {
  const cases = (values.currentCases as number | undefined) ?? 0
  const units = (values.currentUnits as number | undefined) ?? 0
  const quantity = cases * (caseQuantity ?? 1) + units
  if (quantity <= 0) return

  const prisma = db(ctx)
  const warehouse = await prisma.inventoryLocation.findFirst({
    where: { kind: 'WAREHOUSE', active: true },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!warehouse) return

  const caseCost = values.caseCost as string | undefined
  const unitCost =
    caseCost !== undefined
      ? round6(m(caseCost).dividedBy(caseQuantity && caseQuantity > 0 ? caseQuantity : 1)).toString()
      : '0'

  await prisma.$transaction(async (tx) => {
    await postInventoryTransaction(tx, ctx.organizationId, {
      type: 'SUPPLIER_RECEIPT',
      createdByUserId: ctx.userId,
      referenceType: 'ImportJob',
      notes: 'Opening stock from import',
      lines: [{ productId, locationId: warehouse.id, quantityDelta: quantity, unitCost }],
    })
  })
}

async function upsertCustomer(
  ctx: AuthContext,
  values: Record<string, unknown>,
  targetId: string | null,
  resolvedReferences: Record<string, string>,
): Promise<string> {
  const prisma = db(ctx)

  const scalar = definedOnly({
    name: values.name as string | undefined,
    parentCompany: values.parentCompany as string | undefined,
    addressLine1: values.addressLine1 as string | undefined,
    addressLine2: values.addressLine2 as string | undefined,
    city: values.city as string | undefined,
    state: values.state as string | undefined,
    postalCode: values.postalCode as string | undefined,
    phone: values.phone as string | undefined,
    email: values.email as string | undefined,
    paymentTermsCode: values.paymentTerms as 'COD' | 'NET7' | 'NET15' | 'NET30' | undefined,
    creditLimit: values.creditLimit as string | undefined,
    taxExempt: values.taxExempt as boolean | undefined,
    notes: values.notes as string | undefined,
    active: values.active as boolean | undefined,
  })

  let customerId = targetId

  if (customerId) {
    await prisma.customer.update({ where: { id: customerId }, data: scalar })
  } else {
    const accountNumber =
      (values.accountNumber as string | undefined) ??
      (await prisma.$transaction((tx) => nextDocumentNumber(tx, ctx.organizationId, 'CUSTOMER')))

    const created = await prisma.customer.create({
      data: {
        organizationId: ctx.organizationId,
        accountNumber,
        name: (values.name as string) ?? '',
        ...scalar,
      },
      select: { id: true },
    })
    customerId = created.id
  }

  if (values.contactName) {
    await prisma.customerContact.upsert({
      where: { id: `${customerId}-primary` },
      create: {
        id: `${customerId}-primary`,
        organizationId: ctx.organizationId,
        customerId,
        name: values.contactName as string,
        phone: (values.phone as string | undefined) ?? null,
        email: (values.email as string | undefined) ?? null,
        isPrimary: true,
      },
      update: { name: values.contactName as string },
    })
  }

  await applySchedule(ctx, customerId, values, resolvedReferences)
  return customerId
}

async function applySchedule(
  ctx: AuthContext,
  customerId: string,
  values: Record<string, unknown>,
  resolved: Record<string, string>,
): Promise<void> {
  const prisma = db(ctx)

  const routeName = values.route as string | undefined
  const runnerName = values.runner as string | undefined
  let routeTemplateId = (values.routeId as string | undefined) ?? null

  if (!routeTemplateId && routeName) {
    routeTemplateId =
      resolved[`route:${routeName.toLowerCase()}`] ??
      (
        await prisma.routeTemplate.findFirst({
          where: { name: { equals: routeName, mode: 'insensitive' } },
          select: { id: true },
        })
      )?.id ??
      null
  }

  // A runner named in the file only steers which of their routes to use; it
  // never creates a person or reassigns a route behind the owner's back.
  if (!routeTemplateId && runnerName) {
    // The validator has usually already matched the name; fall back to the
    // explicit resolution the user made in the mapping step.
    const runnerId =
      (values.runnerId as string | undefined) ?? resolved[`runner:${runnerName.toLowerCase()}`]
    if (runnerId) {
      routeTemplateId =
        (
          await prisma.routeTemplate.findFirst({
            where: { defaultRunnerUserId: runnerId, active: true },
            select: { id: true },
            orderBy: { name: 'asc' },
          })
        )?.id ?? null
    }
  }

  if (!routeTemplateId) return

  const template = await prisma.routeTemplate.findFirst({
    where: { id: routeTemplateId },
    select: { id: true, dayOfWeek: true },
  })
  if (!template) return

  const dayOfWeek =
    (values.visitDay as 'MONDAY' | undefined) ?? template.dayOfWeek ?? 'MONDAY'
  const frequency = (values.frequency as 'WEEKLY' | undefined) ?? 'WEEKLY'

  await prisma.customerSchedule.upsert({
    where: { customerId_routeTemplateId: { customerId, routeTemplateId: template.id } },
    create: {
      organizationId: ctx.organizationId,
      customerId,
      routeTemplateId: template.id,
      dayOfWeek,
      frequency,
      windowStart: parseWindow(values.preferredTime as string | undefined)?.[0] ?? null,
      windowEnd: parseWindow(values.preferredTime as string | undefined)?.[1] ?? null,
    },
    update: { dayOfWeek, frequency, active: true },
  })
}

function parseWindow(value: string | undefined): [string, string] | null {
  if (!value) return null
  const match = value.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm)?)\s*[-–to]+\s*(\d{1,2}:?\d{0,2}\s*(?:am|pm)?)/i)
  return match ? [match[1].trim().slice(0, 5), match[2].trim().slice(0, 5)] : null
}

async function findOrCreateCategory(ctx: AuthContext, name: string): Promise<string> {
  const prisma = db(ctx)
  const existing = await prisma.productCategory.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  })
  if (existing) return existing.id
  const created = await prisma.productCategory.create({
    data: { organizationId: ctx.organizationId, name },
    select: { id: true },
  })
  return created.id
}

async function findOrCreateSupplier(ctx: AuthContext, name: string): Promise<string> {
  const prisma = db(ctx)
  const existing = await prisma.supplier.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  })
  if (existing) return existing.id
  const created = await prisma.supplier.create({
    data: { organizationId: ctx.organizationId, name },
    select: { id: true },
  })
  return created.id
}

/** Drops undefined keys so an update only touches columns the file carried. */
function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v
  return out as Partial<T>
}
