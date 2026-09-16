import Papa from 'papaparse'
import ExcelJS from 'exceljs'
import { AppError } from '@/lib/errors'

/**
 * Turning an arbitrary spreadsheet into rows.
 *
 * Distributors send whatever their previous system exported: a CSV with a
 * preamble line, an XLSX where row 1 is the company name, headers with trailing
 * spaces, money as "$1,234.56". The parser's job is to find the header row and
 * hand back strings; interpreting them is the validator's job.
 */

export type ParsedSheet = {
  headers: string[]
  rows: Record<string, string>[]
  /** 1-based line in the source file where the header was found. */
  headerRow: number
  truncated: boolean
}

export const MAX_IMPORT_ROWS = 20_000
export const MAX_IMPORT_BYTES = 15 * 1024 * 1024

export type SourceFormat = 'csv' | 'xlsx'

/** Sniffed from the bytes, not the file name — an extension is a claim, not a fact. */
export function detectFormat(fileName: string, bytes: Uint8Array): SourceFormat {
  // XLSX is a zip: "PK\x03\x04".
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'xlsx'
  }
  if (/\.xlsx?$/i.test(fileName) && bytes.length >= 8 && bytes[0] === 0xd0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'That looks like an old .xls file. Save it as .xlsx or .csv and try again.',
    )
  }
  return 'csv'
}

export async function parseSpreadsheet(
  fileName: string,
  bytes: Uint8Array,
): Promise<ParsedSheet> {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new AppError('VALIDATION_FAILED', 'That file is larger than 15 MB. Split it and try again.')
  }
  const grid =
    detectFormat(fileName, bytes) === 'xlsx' ? await readXlsx(bytes) : readCsv(bytes)

  return toSheet(grid)
}

function readCsv(bytes: Uint8Array): string[][] {
  // Strip a UTF-8 BOM; Excel writes one and it corrupts the first header.
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
  const result = Papa.parse<string[]>(text, {
    // Blank lines are KEPT so that a reported line number matches what the
    // person sees in their spreadsheet. They are dropped later, once the header
    // row has been located.
    skipEmptyLines: false,
    // Header handling is ours, because the header is not always on line 1.
    header: false,
  })

  // An empty file trips Papa's delimiter detection; that is not a parse failure
  // worth a scary message, and toSheet reports it properly a moment later.
  const real = result.errors.filter((e) => e.type !== 'Delimiter')
  if (real.length > 0 && result.data.length === 0) {
    throw new AppError('VALIDATION_FAILED', `Could not read that file: ${real[0].message}`)
  }

  return result.data.map((row) => row.map((cell) => String(cell ?? '')))
}

async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer)
  } catch {
    throw new AppError('VALIDATION_FAILED', 'That spreadsheet could not be opened.')
  }

  const sheet = workbook.worksheets.find((w) => w.rowCount > 0) ?? workbook.worksheets[0]
  if (!sheet) throw new AppError('VALIDATION_FAILED', 'That workbook has no sheets.')

  // Placed by their real row number, so a blank row 3 stays row 3 and the line
  // numbers we report match the ones the person sees in Excel.
  const grid: string[][] = []
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellToString(cell)
    })
    grid[row.number - 1] = Array.from(cells, (c) => c ?? '')
  })
  return Array.from(grid, (row) => row ?? [])
}

/**
 * A formula cell is read as its cached result, never as the formula text — both
 * because the formula is meaningless outside its workbook and because writing it
 * back out would be a CSV-injection vector.
 */
function cellToString(cell: ExcelJS.Cell): string {
  const value = cell.value
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    if ('result' in value && value.result !== undefined) return String(value.result)
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('richText' in value) return value.richText.map((r) => r.text).join('')
    if ('hyperlink' in value) return String(value.text ?? value.hyperlink ?? '')
    return ''
  }
  return String(value)
}

/**
 * Finds the header row and normalises the grid.
 *
 * "The header is row 1" is wrong often enough to matter: exports routinely carry
 * a title line, a date, or a blank row first. We take the first row within the
 * top ten that has at least two non-empty cells and looks like labels rather
 * than data.
 */
function toSheet(grid: string[][]): ParsedSheet {
  const cleaned = grid.map((row) => row.map((c) => (c ?? '').trim()))
  const headerIndex = findHeaderRow(cleaned)

  if (headerIndex === -1) {
    throw new AppError(
      'VALIDATION_FAILED',
      'No column headings found. Make sure the first row names the columns.',
    )
  }

  const rawHeaders = cleaned[headerIndex]
  const headers = dedupeHeaders(rawHeaders)

  const body = cleaned.slice(headerIndex + 1).filter((row) => row.some((cell) => cell !== ''))
  const truncated = body.length > MAX_IMPORT_ROWS

  const rows = body.slice(0, MAX_IMPORT_ROWS).map((row) => {
    const record: Record<string, string> = {}
    headers.forEach((header, i) => {
      if (header) record[header] = row[i] ?? ''
    })
    return record
  })

  return { headers: headers.filter(Boolean), rows, headerRow: headerIndex + 1, truncated }
}

function findHeaderRow(grid: string[][]): number {
  // Ten lines is enough for any preamble anyone has actually sent us.
  const limit = Math.min(grid.length, 10)
  for (let i = 0; i < limit; i++) {
    const row = grid[i]
    const filled = row.filter((c) => c !== '')
    if (filled.length < 2) continue
    // Headers are labels. A row that is mostly numbers is data, not a heading.
    const numeric = filled.filter((c) => /^[$-]?[\d.,]+$/.test(c)).length
    if (numeric / filled.length > 0.5) continue
    return i
  }
  return grid.length > 0 && grid[0].some((c) => c !== '') ? 0 : -1
}

/** Two columns called "Price" would silently overwrite each other. */
function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map((header) => {
    const name = header.trim()
    if (!name) return ''
    const count = seen.get(name.toLowerCase()) ?? 0
    seen.set(name.toLowerCase(), count + 1)
    return count === 0 ? name : `${name} (${count + 1})`
  })
}

/**
 * Prefixing a cell that starts with = + - @ stops a spreadsheet treating an
 * exported value as a formula (docs/04 §6).
 */
export function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const escape = (v: string | number | null | undefined) => {
    const s = csvSafe(String(v ?? ''))
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\r\n')
}
