import { fieldsFor, type ImportField } from './fields'
import * as n from './normalize'

/**
 * Per-row validation (docs/03 §5).
 *
 * Every source row becomes an ImportRow with a status and structured messages,
 * so the preview can show counts, the user can fix a cell inline, and the error
 * CSV can be downloaded. Nothing here touches the database — it is a pure
 * function of (row, mapping, what already exists), which is what makes it
 * exhaustively testable.
 */

export type MessageLevel = 'error' | 'warning'

export type RowMessage = {
  level: MessageLevel
  field: string | null
  message: string
}

export type RowVerdict = {
  status: 'READY' | 'WARNING' | 'ERROR'
  action: 'CREATE' | 'UPDATE' | 'SKIP'
  normalized: Record<string, unknown>
  messages: RowMessage[]
  /** The existing record this row will update, when matched. */
  targetId: string | null
  /** Reference values this row needs resolved, e.g. { route: 'Tuesday' }. */
  references: Record<string, string>
}

export type ExistingIndex = {
  /** lowercased natural key → record id */
  bySku: Map<string, string>
  byUpc: Map<string, string>
  byAccountNumber: Map<string, string>
  byName: Map<string, string>
}

export const emptyIndex = (): ExistingIndex => ({
  bySku: new Map(),
  byUpc: new Map(),
  byAccountNumber: new Map(),
  byName: new Map(),
})

export type ValidateOptions = {
  type: 'PRODUCTS' | 'CUSTOMERS'
  mode: 'CREATE_ONLY' | 'UPDATE_ONLY' | 'UPSERT'
  matchKey: 'SKU' | 'UPC' | 'ACCOUNT_NUMBER' | 'NAME'
  mapping: Record<string, string>
  existing: ExistingIndex
  /** Values already claimed by earlier rows in this same file. */
  seen: { sku: Set<string>; upc: Set<string>; accountNumber: Set<string> }
  /** Reference values the user has already resolved, e.g. { 'route:tuesday': 'id' }. */
  resolvedReferences?: Record<string, string>
}

export function validateRow(
  raw: Record<string, string>,
  options: ValidateOptions,
): RowVerdict {
  const fields = fieldsFor(options.type)
  const messages: RowMessage[] = []
  const normalized: Record<string, unknown> = {}
  const references: Record<string, string> = {}

  const cell = (key: string): string | undefined => {
    const header = options.mapping[key]
    return header ? raw[header] : undefined
  }

  for (const field of fields) {
    const value = cell(field.key)
    const parsed = parseField(field, value, messages)
    if (parsed !== undefined) normalized[field.key] = parsed
  }

  // Whether this row creates or updates has to be settled before the required
  // fields are checked. A price list keyed on SKU legitimately carries no
  // product name — demanding one would reject exactly the update-in-place file
  // the spec asks us to support.
  const { targetId, action } = decideAction(normalized, options, messages)

  if (action === 'CREATE') {
    for (const field of fields) {
      if (field.required && normalized[field.key] == null) {
        messages.push({
          level: 'error',
          field: field.key,
          message: options.mapping[field.key]
            ? `${field.label} is empty`
            : `${field.label} is required for a new record — map a column to it`,
        })
      }
    }
  }

  if (options.type === 'PRODUCTS') validateProduct(normalized, options, messages, references, action)
  else validateCustomer(normalized, options, messages, references, action)

  const hasError = messages.some((mm) => mm.level === 'error')
  const hasWarning = messages.some((mm) => mm.level === 'warning')

  return {
    status: hasError ? 'ERROR' : hasWarning ? 'WARNING' : 'READY',
    action: hasError ? 'SKIP' : action,
    normalized,
    messages,
    targetId,
    references,
  }
}

// ── field parsing ────────────────────────────────────────────────────────────

function parseField(
  field: ImportField,
  value: string | undefined,
  messages: RowMessage[],
): unknown {
  const fail = (what: string) => {
    messages.push({ level: 'error', field: field.key, message: `${field.label}: ${what}` })
    return undefined
  }

  switch (field.kind) {
    case 'money': {
      const parsed = n.money(value)
      if (parsed === null) return undefined
      return parsed.ok ? parsed.value : fail(`"${value}" is not an amount`)
    }
    case 'integer': {
      const parsed = n.integer(value)
      if (parsed === null) return undefined
      return parsed.ok ? parsed.value : fail(`"${value}" is not a whole number`)
    }
    case 'boolean': {
      // A column literally called "Inactive" or "Discontinued" means the opposite.
      const inverted = /inactive|discontinued|closed/i.test(field.key)
      const parsed = n.boolean(value, inverted)
      if (parsed === null) return undefined
      return parsed.ok ? parsed.value : fail(`"${value}" is not yes or no`)
    }
    case 'email': {
      const parsed = n.email(value)
      if (parsed === null) return undefined
      if (!parsed.ok) {
        // A bad email is not worth blocking a whole store record over.
        messages.push({
          level: 'warning',
          field: field.key,
          message: `"${value}" is not a valid email — leaving it blank`,
        })
        return undefined
      }
      return parsed.value
    }
    case 'zip': {
      const parsed = n.postalCode(value)
      if (parsed === null) return undefined
      if (!parsed.ok) {
        messages.push({
          level: 'warning',
          field: field.key,
          message: `"${value}" is not a valid ZIP — leaving it blank`,
        })
        return undefined
      }
      return parsed.value
    }
    default:
      return n.text(value) ?? undefined
  }
}

// ── type-specific rules ──────────────────────────────────────────────────────

function validateProduct(
  row: Record<string, unknown>,
  options: ValidateOptions,
  messages: RowMessage[],
  references: Record<string, string>,
  action: 'CREATE' | 'UPDATE' | 'SKIP',
): void {
  const caseQuantity = row.caseQuantity as number | undefined

  if (caseQuantity !== undefined && caseQuantity < 1) {
    messages.push({
      level: 'error',
      field: 'caseQuantity',
      message: 'A case holds at least one unit',
    })
  }

  if (row.currentUnits !== undefined && caseQuantity && (row.currentUnits as number) >= caseQuantity) {
    messages.push({
      level: 'warning',
      field: 'currentUnits',
      message: `${row.currentUnits} loose units is a whole case or more — check the columns are the right way round`,
    })
  }

  if (row.casePrice && row.caseCost) {
    if (Number(row.casePrice) < Number(row.caseCost)) {
      messages.push({
        level: 'warning',
        field: 'casePrice',
        message: 'Case price is below case cost — this product would sell at a loss',
      })
    }
  }

  if (action === 'CREATE' && row.casePrice === undefined && row.unitPrice === undefined) {
    messages.push({
      level: 'warning',
      field: 'casePrice',
      message: 'No selling price — this product will import at zero',
    })
  }

  for (const key of ['category', 'supplier'] as const) {
    const value = row[key] as string | undefined
    if (value) references[key] = value
  }

  duplicateChecks(row, options, messages, [
    ['sku', 'sku', 'SKU'],
    ['upc', 'upc', 'UPC'],
  ])
}

function validateCustomer(
  row: Record<string, unknown>,
  options: ValidateOptions,
  messages: RowMessage[],
  references: Record<string, string>,
  action: 'CREATE' | 'UPDATE' | 'SKIP',
): void {
  if (action === 'CREATE' && !row.addressLine1 && !row.city) {
    messages.push({
      level: 'warning',
      field: 'addressLine1',
      message: 'No address — this store cannot be routed or navigated to',
    })
  }

  for (const [key, parse, label] of [
    ['visitDay', n.dayOfWeek, 'Visit day'],
    ['frequency', n.frequency, 'Frequency'],
    ['paymentTerms', n.paymentTerms, 'Payment terms'],
  ] as const) {
    const value = row[key] as string | undefined
    if (value === undefined) continue
    const parsed = parse(value)
    if (parsed && !parsed.ok) {
      messages.push({
        level: 'warning',
        field: key,
        message: `${label} "${value}" was not recognised — leaving it unset`,
      })
      delete row[key]
    } else if (parsed && parsed.ok) {
      row[key] = parsed.value
    }
  }

  if (row.phone) row.phone = n.phone(row.phone as string)

  // Route and runner are resolved against existing records in an explicit step.
  // The importer never silently creates a user or a route (docs/03 §5).
  for (const key of ['route', 'runner'] as const) {
    const value = row[key] as string | undefined
    if (!value) continue
    references[key] = value

    const resolved = options.resolvedReferences?.[`${key}:${value.toLowerCase()}`]
    if (resolved) {
      row[`${key}Id`] = resolved
    } else {
      messages.push({
        level: 'warning',
        field: key,
        message:
          key === 'runner'
            ? `"${value}" needs to be matched to someone on your team`
            : `"${value}" needs to be matched to a route`,
      })
    }
  }

  if (row.currentBalance && Number(row.currentBalance) !== 0) {
    messages.push({
      level: 'warning',
      field: 'currentBalance',
      message: `An opening balance of ${row.currentBalance} will be recorded as an opening invoice`,
    })
  }

  duplicateChecks(row, options, messages, [['accountNumber', 'accountNumber', 'Account number']])
}

function duplicateChecks(
  row: Record<string, unknown>,
  options: ValidateOptions,
  messages: RowMessage[],
  checks: [keyof Record<string, unknown>, 'sku' | 'upc' | 'accountNumber', string][],
): void {
  for (const [rowKey, seenKey, label] of checks) {
    const value = row[rowKey as string] as string | undefined
    if (!value) continue
    const lowered = value.toLowerCase()
    if (options.seen[seenKey].has(lowered)) {
      messages.push({
        level: 'error',
        field: rowKey as string,
        message: `${label} ${value} appears more than once in this file`,
      })
    }
  }
}

// ── create vs update ─────────────────────────────────────────────────────────

function decideAction(
  row: Record<string, unknown>,
  options: ValidateOptions,
  messages: RowMessage[],
): { targetId: string | null; action: 'CREATE' | 'UPDATE' | 'SKIP' } {
  const lookup = (value: unknown, index: Map<string, string>) =>
    typeof value === 'string' && value ? (index.get(value.toLowerCase()) ?? null) : null

  // Match on the declared key first, then fall back to the other natural keys —
  // a file keyed on SKU can still recognise a product by its UPC, which is what
  // stops a re-import creating duplicates.
  const candidates =
    options.type === 'PRODUCTS'
      ? options.matchKey === 'UPC'
        ? [lookup(row.upc, options.existing.byUpc), lookup(row.sku, options.existing.bySku)]
        : [lookup(row.sku, options.existing.bySku), lookup(row.upc, options.existing.byUpc)]
      : options.matchKey === 'NAME'
        ? [
            lookup(row.name, options.existing.byName),
            lookup(row.accountNumber, options.existing.byAccountNumber),
          ]
        : [
            lookup(row.accountNumber, options.existing.byAccountNumber),
            lookup(row.name, options.existing.byName),
          ]

  const targetId = candidates.find(Boolean) ?? null

  if (targetId) {
    if (options.mode === 'CREATE_ONLY') {
      messages.push({
        level: 'error',
        field: null,
        message: 'This record already exists. Switch to update mode to change it.',
      })
      return { targetId, action: 'SKIP' }
    }
    return { targetId, action: 'UPDATE' }
  }

  if (options.mode === 'UPDATE_ONLY') {
    messages.push({
      level: 'warning',
      field: null,
      message: 'No matching record to update — this row will be skipped',
    })
    return { targetId: null, action: 'SKIP' }
  }

  return { targetId: null, action: 'CREATE' }
}
