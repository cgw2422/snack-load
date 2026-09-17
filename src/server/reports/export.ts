import ExcelJS from 'exceljs'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { ColumnFormat, ReportColumn, ReportResult, ReportRow } from './types'
import { toWinAnsi } from '@/server/documents/winAnsi'

/**
 * Report exports (spec §34).
 *
 * Three formats, one rule: **the definition travels with the numbers.** A
 * spreadsheet forwarded to an accountant, or a PDF printed for a bank, has to
 * carry what its columns mean and when it was run — otherwise a column headed
 * "Gross profit" gets read as profit six weeks later by somebody who never saw
 * this screen.
 *
 * Money stays a decimal string into CSV and PDF. Excel is the one exception:
 * the cell is written as a number so the recipient can sum a column, which is
 * the entire reason they asked for Excel. That conversion happens here, at the
 * boundary, and nowhere else (docs/02 §M2).
 */

export type ExportFormat = 'csv' | 'xlsx' | 'pdf'

export function exportFileName(report: ReportResult, format: ExportFormat): string {
  const slug = report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${slug}-${report.filters.from}-to-${report.filters.to}.${format}`
}

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

export function toCsv(report: ReportResult): string {
  const lines: string[] = [
    csvRow([report.title]),
    csvRow([report.appliedTo]),
    csvRow([`Generated ${formatDateTime(report.generatedAt, report.timeZone)}`]),
    csvRow(['Definition', report.definition]),
    ...report.notes.map((note) => csvRow(['Note', note])),
    '',
    csvRow(report.columns.map((c) => c.label)),
    ...report.rows.map((row) => csvRow(report.columns.map((c) => cellText(row[c.key], c.format)))),
  ]

  if (report.totals) {
    lines.push(
      csvRow(report.columns.map((c) => cellText(report.totals![c.key], c.format))),
    )
  }

  // A leading BOM so Excel on Windows opens UTF-8 without mangling names.
  return `﻿${lines.join('\r\n')}\r\n`
}

function csvRow(values: (string | null)[]): string {
  return values.map(csvCell).join(',')
}

function csvCell(value: string | null): string {
  const text = value ?? ''
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
  // Prefixing with an apostrophe is the standard defusal (docs/04 §6).
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

// ─── Excel ───────────────────────────────────────────────────────────────────

export async function toXlsx(report: ReportResult): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook()
  book.creator = 'SnackLoad'
  book.created = new Date(report.generatedAt)

  const sheet = book.addWorksheet(report.title.slice(0, 31))

  sheet.addRow([report.title]).font = { bold: true, size: 14 }
  sheet.addRow([report.appliedTo]).font = { color: { argb: 'FF64748B' } }
  sheet.addRow([`Generated ${formatDateTime(report.generatedAt, report.timeZone)}`]).font = {
    color: { argb: 'FF64748B' },
  }
  sheet.addRow([])

  const definition = sheet.addRow(['What this measures', report.definition])
  definition.getCell(1).font = { bold: true }
  definition.getCell(2).alignment = { wrapText: true, vertical: 'top' }
  definition.height = 58

  for (const note of report.notes) {
    const row = sheet.addRow(['Note', note])
    row.getCell(2).font = { color: { argb: 'FF64748B' } }
  }
  sheet.addRow([])

  const header = sheet.addRow(report.columns.map((c) => c.label))
  header.font = { bold: true }
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
  })

  const headerRowNumber = header.number

  for (const row of report.rows) {
    addDataRow(sheet, report.columns, row)
  }

  if (report.totals) {
    const totals = addDataRow(sheet, report.columns, report.totals)
    totals.font = { bold: true }
    totals.eachCell((cell) => {
      cell.border = { top: { style: 'thin', color: { argb: 'FFCBD5E1' } } }
    })
  }

  report.columns.forEach((column, index) => {
    const col = sheet.getColumn(index + 1)
    col.width = column.format === 'text' ? 28 : 14
    if (column.format === 'money') col.numFmt = '#,##0.00'
    if (column.format === 'percent') col.numFmt = '0.00"%"'
    if (column.format === 'number') col.numFmt = '#,##0'
  })

  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }]
  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber, column: report.columns.length },
  }

  const buffer = await book.xlsx.writeBuffer()
  return new Uint8Array(buffer as ArrayBuffer)
}

function addDataRow(
  sheet: ExcelJS.Worksheet,
  columns: ReportColumn[],
  row: ReportRow,
): ExcelJS.Row {
  return sheet.addRow(
    columns.map((column) => {
      const raw = row[column.key]
      if (raw === null || raw === undefined || raw === '') return null

      // Numeric only where a recipient would want to sum or sort it. The
      // conversion from decimal string to float happens here and only here.
      if (column.format === 'money' || column.format === 'percent') return Number(raw)
      if (column.format === 'number') return Number(raw)
      if (column.format === 'date') return new Date(String(raw))
      return String(raw)
    }),
  )
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

const INK = rgb(0.06, 0.09, 0.16)
const MUTED = rgb(0.42, 0.47, 0.55)
const RULE = rgb(0.82, 0.85, 0.89)

/** Landscape: a report with nine columns does not fit a portrait page. */
const LANDSCAPE: [number, number] = [792, 612]

export async function toPdf(report: ReportResult): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(report.title)
  pdf.setSubject(report.definition)
  pdf.setCreator('SnackLoad')

  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const margin = 36
  const right = LANDSCAPE[0] - margin
  const width = right - margin

  // Text columns take the slack; figures need only enough for their digits.
  const textColumns = report.columns.filter((c) => c.format === 'text').length || 1
  const figureWidth = 66
  const textWidth = Math.max(
    90,
    (width - (report.columns.length - textColumns) * figureWidth) / textColumns,
  )
  const widths = report.columns.map((c) => (c.format === 'text' ? textWidth : figureWidth))
  const offsets = widths.reduce<number[]>((acc, w, i) => {
    acc.push(i === 0 ? margin : acc[i - 1] + widths[i - 1])
    return acc
  }, [])

  let page = pdf.addPage(LANDSCAPE)
  let y = LANDSCAPE[1] - margin

  const drawHeader = (first: boolean) => {
    if (first) {
      drawText(page, report.title, { x: margin, y: y - 14, size: 15, font: bold, color: INK })
      y -= 20
      drawText(page, report.appliedTo, { x: margin, y: y - 9, size: 9, font, color: MUTED })
      y -= 13
      drawText(page, `Generated ${formatDateTime(report.generatedAt, report.timeZone)}`, {
        x: margin, y: y - 8, size: 8, font, color: MUTED,
      })
      y -= 16

      for (const line of wrap(report.definition, font, 8, width)) {
        drawText(page, line, { x: margin, y: y - 8, size: 8, font, color: MUTED })
        y -= 10
      }
      y -= 8
    }

    page.drawLine({ start: { x: margin, y }, end: { x: right, y }, thickness: 0.75, color: RULE })
    y -= 12
    report.columns.forEach((column, index) => {
      const label = truncate(column.label, bold, 8, widths[index] - 4)
      if (column.format === 'text') {
        drawText(page, label, { x: offsets[index], y, size: 8, font: bold, color: MUTED })
      } else {
        drawText(page, label, {
          x: offsets[index] + widths[index] - 4 - bold.widthOfTextAtSize(label, 8),
          y, size: 8, font: bold, color: MUTED,
        })
      }
    })
    y -= 6
    page.drawLine({ start: { x: margin, y }, end: { x: right, y }, thickness: 0.75, color: RULE })
    y -= 12
  }

  drawHeader(true)

  const drawRow = (row: ReportRow, emphasis = false) => {
    if (y < margin + 40) {
      page = pdf.addPage(LANDSCAPE)
      y = LANDSCAPE[1] - margin
      drawHeader(false)
    }

    report.columns.forEach((column, index) => {
      const text = cellText(row[column.key], column.format, report.timeZone) ?? '—'
      const face = emphasis || column.primary ? bold : font
      const clipped = truncate(text, face, 8.5, widths[index] - 4)

      if (column.format === 'text') {
        drawText(page, clipped, { x: offsets[index], y, size: 8.5, font: face, color: INK })
      } else {
        drawText(page, clipped, {
          x: offsets[index] + widths[index] - 4 - face.widthOfTextAtSize(clipped, 8.5),
          y, size: 8.5, font: face, color: INK,
        })
      }
    })
    y -= 13
  }

  for (const row of report.rows) drawRow(row)

  if (report.totals) {
    y -= 2
    page.drawLine({ start: { x: margin, y: y + 8 }, end: { x: right, y: y + 8 }, thickness: 0.75, color: RULE })
    drawRow(report.totals, true)
  }

  if (report.notes.length > 0) {
    y -= 10
    for (const note of report.notes) {
      for (const line of wrap(`• ${note}`, font, 8, width)) {
        if (y < margin + 20) {
          page = pdf.addPage(LANDSCAPE)
          y = LANDSCAPE[1] - margin
        }
        drawText(page, line, { x: margin, y, size: 8, font, color: MUTED })
        y -= 10
      }
    }
  }

  return pdf.save()
}

// ─── shared formatting ───────────────────────────────────────────────────────

function cellText(
  value: string | number | null | undefined,
  format: ColumnFormat,
  timeZone = 'UTC',
): string | null {
  if (value === null || value === undefined || value === '') return null

  switch (format) {
    case 'money':
      // Kept as a plain decimal string: a currency symbol and thousands
      // separators are formatting a spreadsheet would have to undo.
      return Number(value).toFixed(2)
    case 'percent':
      return `${Number(value).toFixed(2)}%`
    case 'number':
      return String(value)
    case 'date':
      return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(
        new Date(String(value)),
      )
    default:
      return String(value)
  }
}

function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso))
}

function truncate(value: string, font: PDFFont, size: number, max: number): string {
  value = toWinAnsi(value)
  if (font.widthOfTextAtSize(value, size) <= max) return value
  let out = value
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > max) out = out.slice(0, -1)
  return `${out}…`
}

function wrap(value: string, font: PDFFont, size: number, max: number): string[] {
  value = toWinAnsi(value)
  const lines: string[] = []
  let current = ''
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= max) {
      current = candidate
    } else {
      if (current) lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * Every string drawn on a page goes through here. pdf-lib's standard fonts
 * throw on a character they cannot encode, so sanitising at the single draw
 * boundary is what keeps one stray em dash from failing a whole download.
 */
function drawText(
  page: PDFPage,
  value: string,
  options: Parameters<PDFPage['drawText']>[1],
): void {
  page.drawText(toWinAnsi(value), options)
}
