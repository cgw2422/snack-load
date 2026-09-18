import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { DocumentParty, ReceiptDocument } from './types'
import { toWinAnsi } from './winAnsi'

/**
 * Receipt and invoice PDFs (spec §24).
 *
 * Two layouts over one document value: US Letter for the office, and an 80 mm
 * roll for a thermal printer. Both are drawn from `ReceiptDocument`, which is
 * built from what was posted with the sale — so a reprint a year later shows
 * the prices charged and the address delivered to, not today's.
 *
 * Nothing here talks to a printer. Producing bytes and getting them to paper
 * are separate problems: the browser can only offer a print dialog, while a
 * native app will drive a Bluetooth thermal printer directly. Both consume
 * these same bytes (docs/05 §5).
 */

const INK = rgb(0.06, 0.09, 0.16)
const MUTED = rgb(0.42, 0.47, 0.55)
const RULE = rgb(0.82, 0.85, 0.89)
const DANGER = rgb(0.77, 0.15, 0.15)
const PAID = rgb(0.05, 0.47, 0.25)

const LETTER: [number, number] = [612, 792]
/** 80 mm at 72 dpi, less the 2–3 mm a thermal head cannot reach either side. */
const THERMAL_WIDTH = 204

export type PdfLayout = 'full' | 'thermal'

export async function renderReceiptPdf(
  doc: ReceiptDocument,
  layout: PdfLayout = 'full',
): Promise<Uint8Array> {
  return layout === 'thermal' ? renderThermal(doc) : renderFullPage(doc)
}

/** The filename a store sees when they save it. */
export function receiptFileName(doc: ReceiptDocument, layout: PdfLayout = 'full'): string {
  const store = doc.billTo.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  if (doc.kind === 'creditMemo') {
    return `${doc.receiptNumber}-${store}-credit.pdf`.replace(/-+/g, '-')
  }
  const suffix = layout === 'thermal' ? '-receipt' : ''
  return `${doc.receiptNumber}-${store}${suffix}.pdf`.replace(/-+/g, '-')
}

// ─── full page ───────────────────────────────────────────────────────────────

async function renderFullPage(doc: ReceiptDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`${doc.receiptNumber} · ${doc.billTo.name}`)
  pdf.setAuthor(doc.issuer.name)
  pdf.setSubject(Number(doc.balanceDue) > 0 ? 'Invoice' : 'Receipt')
  pdf.setCreator('SnackLoad')

  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const logo = await embedLogo(pdf, doc.logoUrl)

  const margin = 54
  const right = LETTER[0] - margin
  let page = pdf.addPage(LETTER)
  let y = LETTER[1] - margin

  const newPage = () => {
    page = pdf.addPage(LETTER)
    y = LETTER[1] - margin
  }
  const room = (needed: number) => {
    if (y - needed < margin + 40) newPage()
  }

  // ── masthead ──
  if (logo) {
    const scaled = logo.scaleToFit(150, 44)
    page.drawImage(logo, { x: margin, y: y - scaled.height, width: scaled.width, height: scaled.height })
    y -= scaled.height + 10
  }

  drawText(page, doc.issuer.name, { x: margin, y: y - 16, size: 16, font: bold, color: INK })
  const isCredit = doc.kind === 'creditMemo'
  const heading = isCredit ? 'CREDIT MEMO' : Number(doc.balanceDue) > 0 ? 'INVOICE' : 'RECEIPT'
  drawText(page, heading, {
    x: right - bold.widthOfTextAtSize(heading, 20),
    y: y - 18,
    size: 20,
    font: bold,
    color: INK,
  })
  y -= 22

  for (const line of [doc.issuer.subtitle, ...doc.issuer.addressLines, contactLine(doc.issuer)]) {
    if (!line) continue
    drawText(page, line, { x: margin, y: y - 10, size: 9, font, color: MUTED })
    y -= 12
  }

  // ── void stamp ──
  if (doc.void) {
    y -= 10
    const label = 'VOIDED'
    page.drawRectangle({
      x: margin, y: y - 26, width: right - margin, height: 30,
      color: rgb(0.99, 0.93, 0.93), borderColor: DANGER, borderWidth: 1,
    })
    drawText(page, label, { x: margin + 12, y: y - 17, size: 13, font: bold, color: DANGER })
    const detail = [
      `Voided ${formatDateTime(doc.void.voidedAt, doc.timeZone)}`,
      doc.void.voidedByName ? `by ${doc.void.voidedByName}` : null,
      doc.void.reason,
    ]
      .filter(Boolean)
      .join(' · ')
    drawText(page, truncate(detail, font, 8, right - margin - 90), {
      x: margin + 78, y: y - 16, size: 8, font, color: DANGER,
    })
    y -= 40
  } else {
    y -= 18
  }

  // ── bill to / document facts ──
  const factsX = right - 210
  const blockTop = y

  drawText(page, 'BILL TO', { x: margin, y, size: 8, font: bold, color: MUTED })
  y -= 14
  drawText(page, doc.billTo.name, { x: margin, y, size: 11, font: bold, color: INK })
  y -= 13
  for (const line of [doc.billTo.subtitle, ...doc.billTo.addressLines, contactLine(doc.billTo)]) {
    if (!line) continue
    drawText(page, line, { x: margin, y, size: 9, font, color: MUTED })
    y -= 11
  }

  let factsY = blockTop
  const facts: [string, string][] = isCredit
    ? [
        ['Credit memo no.', doc.receiptNumber],
        ...(doc.credit?.againstSaleNumber
          ? ([['Original invoice', doc.credit.againstSaleNumber]] as [string, string][])
          : []),
        ['Return no.', doc.saleNumber],
        ['Date', formatDateTime(doc.occurredAt, doc.timeZone)],
        ['Reason', doc.credit?.reason ?? ''],
        ...(doc.soldByName ? ([['Issued by', doc.soldByName]] as [string, string][]) : []),
      ]
    : [
        [heading === 'INVOICE' ? 'Invoice no.' : 'Receipt no.', doc.receiptNumber],
        ['Order no.', doc.saleNumber],
        ['Date', formatDateTime(doc.occurredAt, doc.timeZone)],
        ['Sold by', doc.soldByName],
        ['Terms', doc.paymentTermsCode],
      ]
  if (!isCredit && doc.dueDate && Number(doc.balanceDue) > 0) {
    facts.push(['Due', formatDate(doc.dueDate, doc.timeZone)])
  }
  for (const [label, value] of facts) {
    drawText(page, label, { x: factsX, y: factsY, size: 9, font, color: MUTED })
    drawText(page, value, {
      x: right - font.widthOfTextAtSize(value, 9),
      y: factsY,
      size: 9,
      font: bold,
      color: INK,
    })
    factsY -= 13
  }

  y = Math.min(y, factsY) - 18

  // ── line items ──
  const columns = {
    item: margin,
    qty: margin + 250,
    uom: margin + 290,
    price: margin + 380,
    total: right,
  }

  const drawItemHeader = () => {
    page.drawLine({
      start: { x: margin, y: y + 12 }, end: { x: right, y: y + 12 },
      thickness: 0.75, color: RULE,
    })
    drawText(page, 'ITEM', { x: columns.item, y, size: 8, font: bold, color: MUTED })
    drawText(page, 'QTY', { x: columns.qty, y, size: 8, font: bold, color: MUTED })
    drawText(page, 'UNIT', { x: columns.uom, y, size: 8, font: bold, color: MUTED })
    rightText(page, 'PRICE', columns.price + 40, y, 8, bold, MUTED)
    rightText(page, 'AMOUNT', columns.total, y, 8, bold, MUTED)
    y -= 6
    page.drawLine({
      start: { x: margin, y }, end: { x: right, y },
      thickness: 0.75, color: RULE,
    })
    y -= 14
  }
  drawItemHeader()

  for (const line of doc.lines) {
    room(34)
    if (y === LETTER[1] - margin) drawItemHeader()

    drawText(page, truncate(line.name, bold, 10, 240), {
      x: columns.item, y, size: 10, font: bold, color: INK,
    })
    drawText(page, String(line.quantity), { x: columns.qty, y, size: 10, font, color: INK })
    drawText(page, truncate(line.uomLabel, font, 10, 85), {
      x: columns.uom, y, size: 10, font, color: INK,
    })
    rightText(page, money(line.unitPrice, doc.currency), columns.price + 40, y, 10, font, INK)
    // The extended price, before discount and tax: this column has to add up to
    // the Subtotal printed below it, because that is the first thing a store
    // clerk checks with a pen.
    rightText(page, money(line.lineSubtotal, doc.currency), columns.total, y, 10, bold, INK)
    y -= 12

    const sub: string[] = [`SKU ${line.sku}`]
    if (Number(line.discountAmount) > 0) {
      sub.push(`less ${money(line.discountAmount, doc.currency)}`)
    }
    drawText(page, sub.join(' · '), { x: columns.item, y, size: 8, font, color: MUTED })
    y -= 14
  }

  // ── totals ──
  room(140)
  y -= 6
  page.drawLine({ start: { x: margin, y }, end: { x: right, y }, thickness: 0.75, color: RULE })
  y -= 18

  const totalsLabelX = right - 200
  const totalRow = (label: string, value: string, emphasis = false, color = INK) => {
    drawText(page, label, {
      x: totalsLabelX, y, size: emphasis ? 11 : 9,
      font: emphasis ? bold : font, color: emphasis ? INK : MUTED,
    })
    rightText(page, value, right, y, emphasis ? 12 : 9, bold, color)
    y -= emphasis ? 18 : 14
  }

  totalRow('Subtotal', money(doc.subtotal, doc.currency))
  if (Number(doc.discountTotal) > 0) {
    totalRow('Discount', `-${money(doc.discountTotal, doc.currency)}`)
  }
  totalRow(isCredit ? 'Tax reversed' : 'Tax', money(doc.taxTotal, doc.currency))
  page.drawLine({
    start: { x: totalsLabelX, y: y + 6 }, end: { x: right, y: y + 6 },
    thickness: 0.75, color: RULE,
  })
  y -= 4
  totalRow(isCredit ? 'Total credit' : 'Total', money(doc.total, doc.currency), true)

  for (const payment of doc.payments) {
    const label = [
      `${isCredit ? 'Refunded' : 'Paid'} - ${methodLabel(payment.method)}`,
      payment.reference ? `#${payment.reference}` : null,
    ]
      .filter(Boolean)
      .join(' ')
    totalRow(label, money(payment.amount, doc.currency))
  }

  page.drawLine({
    start: { x: totalsLabelX, y: y + 6 }, end: { x: right, y: y + 6 },
    thickness: 0.75, color: RULE,
  })
  y -= 4

  if (isCredit) {
    if (Number(doc.credit?.applied ?? 0) > 0) {
      totalRow('Applied to invoices', money(doc.credit!.applied, doc.currency))
    }
    totalRow('Credit remaining', money(doc.credit?.remaining ?? '0', doc.currency), true, PAID)

    // The one line a store actually reads: what happened to their money.
    if (doc.credit?.disposition) {
      room(30)
      y -= 6
      for (const line of wrap(doc.credit.disposition, bold, 9, right - margin)) {
        drawText(page, line, { x: margin, y, size: 9, font: bold, color: INK })
        y -= 12
      }
    }
    if (doc.credit?.returnedLines.length) {
      for (const line of doc.credit.returnedLines) {
        room(16)
        drawText(page, `${line.quantity} x ${line.uomLabel} ${line.name} - ${line.disposition}`, {
          x: margin, y, size: 8, font, color: MUTED,
        })
        y -= 11
      }
    }
  } else {
    const owed = Number(doc.balanceDue) > 0
    totalRow(
      owed ? 'Balance due' : 'Paid in full',
      owed ? money(doc.balanceDue, doc.currency) : money('0', doc.currency),
      true,
      owed ? DANGER : PAID,
    )
  }

  // ── notes and signature ──
  if (doc.notes) {
    room(46)
    y -= 10
    drawText(page, 'NOTES', { x: margin, y, size: 8, font: bold, color: MUTED })
    y -= 12
    for (const line of wrap(doc.notes, font, 9, right - margin)) {
      room(16)
      drawText(page, line, { x: margin, y, size: 9, font, color: INK })
      y -= 11
    }
  }

  if (doc.signature) {
    room(90)
    y -= 16
    const image = doc.signature.imagePng ? await embedPng(pdf, doc.signature.imagePng) : null
    if (image) {
      const scaled = image.scaleToFit(200, 52)
      page.drawImage(image, { x: margin, y: y - scaled.height, width: scaled.width, height: scaled.height })
      y -= scaled.height + 4
    }
    page.drawLine({ start: { x: margin, y }, end: { x: margin + 220, y }, thickness: 0.75, color: RULE })
    y -= 11
    const who = doc.signature.signerName ?? 'Received by'
    drawText(page, 
      `${who} · ${formatDateTime(doc.signature.capturedAt, doc.timeZone)}`,
      { x: margin, y, size: 8, font, color: MUTED },
    )
    y -= 14
  }

  if (doc.footer) {
    const lines = wrap(doc.footer, font, 8, right - margin)
    for (const [index, line] of lines.entries()) {
      drawText(page, line, {
        x: margin + (right - margin) / 2 - font.widthOfTextAtSize(line, 8) / 2,
        y: margin - 8 + (lines.length - index - 1) * 10,
        size: 8,
        font,
        color: MUTED,
      })
    }
  }

  return pdf.save()
}

// ─── thermal roll ────────────────────────────────────────────────────────────

/**
 * One continuous 80 mm page, sized to its content — a roll has no page break,
 * and a fixed height would eject a foot of blank paper after a two-line sale.
 */
async function renderThermal(doc: ReceiptDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`${doc.receiptNumber} · ${doc.billTo.name}`)
  pdf.setCreator('SnackLoad')

  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const logo = await embedLogo(pdf, doc.logoUrl)
  const signature = doc.signature?.imagePng ? await embedPng(pdf, doc.signature.imagePng) : null

  const pad = 10
  const width = THERMAL_WIDTH
  const inner = width - pad * 2

  // Two passes: measure, then draw. pdf-lib needs the page height up front and
  // the roll's height is whatever the receipt turns out to be.
  const plan = planThermal(doc, font, bold, inner)
  const logoHeight = logo ? logo.scaleToFit(inner, 34).height + 6 : 0
  const signatureHeight = signature ? signature.scaleToFit(inner, 40).height + 4 : 0
  const height = pad * 2 + plan.height + logoHeight + signatureHeight

  const page = pdf.addPage([width, height])
  let y = height - pad

  if (logo) {
    const scaled = logo.scaleToFit(inner, 34)
    page.drawImage(logo, {
      x: (width - scaled.width) / 2, y: y - scaled.height,
      width: scaled.width, height: scaled.height,
    })
    y -= scaled.height + 6
  }

  for (const row of plan.rows) {
    if (row.kind === 'rule') {
      page.drawLine({
        start: { x: pad, y: y - 3 }, end: { x: width - pad, y: y - 3 },
        thickness: 0.5, color: RULE,
      })
      y -= row.height
      continue
    }

    if (row.kind === 'signature') {
      if (signature) {
        const scaled = signature.scaleToFit(inner, 40)
        page.drawImage(signature, {
          x: (width - scaled.width) / 2, y: y - scaled.height,
          width: scaled.width, height: scaled.height,
        })
        y -= scaled.height + 4
      }
      y -= row.height
      continue
    }

    const face = row.bold ? bold : font
    if (row.right !== undefined) {
      drawText(page, row.text, { x: pad, y: y - row.size, size: row.size, font: face, color: row.color })
      rightText(page, row.right, width - pad, y - row.size, row.size, row.bold ? bold : font, row.color)
    } else if (row.center) {
      drawText(page, row.text, {
        x: (width - face.widthOfTextAtSize(row.text, row.size)) / 2,
        y: y - row.size, size: row.size, font: face, color: row.color,
      })
    } else {
      drawText(page, row.text, { x: pad, y: y - row.size, size: row.size, font: face, color: row.color })
    }
    y -= row.height
  }

  return pdf.save()
}

type ThermalRow =
  | { kind: 'rule'; height: number }
  | { kind: 'signature'; height: number }
  | {
      kind: 'text'
      text: string
      right?: string
      size: number
      bold: boolean
      center: boolean
      color: ReturnType<typeof rgb>
      height: number
    }

function planThermal(
  doc: ReceiptDocument,
  font: PDFFont,
  bold: PDFFont,
  inner: number,
): { rows: ThermalRow[]; height: number } {
  const rows: ThermalRow[] = []

  const text = (
    value: string,
    options: {
      right?: string
      size?: number
      bold?: boolean
      center?: boolean
      color?: ReturnType<typeof rgb>
      gap?: number
    } = {},
  ) => {
    const size = options.size ?? 7
    rows.push({
      kind: 'text',
      text: value,
      right: options.right,
      size,
      bold: options.bold ?? false,
      center: options.center ?? false,
      color: options.color ?? INK,
      height: size + (options.gap ?? 3),
    })
  }
  const rule = () => rows.push({ kind: 'rule', height: 8 })

  text(doc.issuer.name, { size: 10, bold: true, center: true })
  for (const line of [...doc.issuer.addressLines, contactLine(doc.issuer)]) {
    if (line) text(line, { size: 6, center: true, color: MUTED })
  }

  if (doc.void) {
    rule()
    text('*** VOIDED ***', { size: 9, bold: true, center: true, color: DANGER })
    text(formatDateTime(doc.void.voidedAt, doc.timeZone), { size: 6, center: true, color: DANGER })
    if (doc.void.reason) {
      for (const line of wrap(doc.void.reason, font, 6, inner)) {
        text(line, { size: 6, center: true, color: DANGER })
      }
    }
  }

  const isCredit = doc.kind === 'creditMemo'

  rule()
  if (isCredit) {
    text('CREDIT MEMO', { size: 9, bold: true, center: true })
    text('Credit memo', { right: doc.receiptNumber, bold: true })
    if (doc.credit?.againstSaleNumber) {
      text('Original', { right: doc.credit.againstSaleNumber, color: MUTED })
    }
    text('Return', { right: doc.saleNumber, color: MUTED })
    text('Date', { right: formatDateTime(doc.occurredAt, doc.timeZone), color: MUTED })
    text('Reason', { right: doc.credit?.reason ?? '', color: MUTED })
  } else {
    // Same rule as the full page and the screen: money still owed makes it an
    // invoice, not a receipt.
    text(Number(doc.balanceDue) > 0 ? 'Invoice' : 'Receipt', {
      right: doc.receiptNumber,
      bold: true,
    })
    text('Order', { right: doc.saleNumber, color: MUTED })
    text('Date', { right: formatDateTime(doc.occurredAt, doc.timeZone), color: MUTED })
    text('Sold by', { right: doc.soldByName, color: MUTED })
    text('Terms', { right: doc.paymentTermsCode, color: MUTED })
  }

  rule()
  text(doc.billTo.name, { size: 8, bold: true })
  for (const line of [doc.billTo.subtitle, ...doc.billTo.addressLines]) {
    if (line) text(line, { size: 6, color: MUTED })
  }

  rule()
  for (const line of doc.lines) {
    for (const part of wrap(line.name, bold, 7, inner)) {
      text(part, { bold: true })
    }
    text(`${line.quantity} x ${line.uomLabel} @ ${money(line.unitPrice, doc.currency)}`, {
      right: money(line.lineSubtotal, doc.currency),
      size: 6,
      color: MUTED,
    })
    if (Number(line.discountAmount) > 0) {
      text(`less ${money(line.discountAmount, doc.currency)}`, { size: 6, color: MUTED })
    }
  }

  rule()
  text('Subtotal', { right: money(doc.subtotal, doc.currency), color: MUTED })
  if (Number(doc.discountTotal) > 0) {
    text('Discount', { right: `-${money(doc.discountTotal, doc.currency)}`, color: MUTED })
  }
  text(isCredit ? 'Tax reversed' : 'Tax', {
    right: money(doc.taxTotal, doc.currency),
    color: MUTED,
  })
  text(isCredit ? 'TOTAL CREDIT' : 'TOTAL', {
    right: money(doc.total, doc.currency),
    size: 10,
    bold: true,
  })

  for (const payment of doc.payments) {
    const label = [methodLabel(payment.method), payment.reference ? `#${payment.reference}` : null]
      .filter(Boolean)
      .join(' ')
    text(`${isCredit ? 'Refunded' : 'Paid'} ${label}`, {
      right: money(payment.amount, doc.currency),
      color: MUTED,
    })
  }

  if (isCredit) {
    if (Number(doc.credit?.applied ?? 0) > 0) {
      text('Applied', { right: money(doc.credit!.applied, doc.currency), color: MUTED })
    }
    text('CREDIT LEFT', {
      right: money(doc.credit?.remaining ?? '0', doc.currency),
      size: 9,
      bold: true,
      color: PAID,
    })
    if (doc.credit?.disposition) {
      rule()
      for (const line of wrap(doc.credit.disposition, bold, 7, inner)) {
        text(line, { size: 7, bold: true, center: true })
      }
    }
    for (const line of doc.credit?.returnedLines ?? []) {
      for (const part of wrap(
        `${line.quantity} x ${line.uomLabel} ${line.name} - ${line.disposition}`,
        font,
        6,
        inner,
      )) {
        text(part, { size: 6, color: MUTED })
      }
    }
  } else {
    const owed = Number(doc.balanceDue) > 0
    text(owed ? 'BALANCE DUE' : 'PAID IN FULL', {
      right: owed ? money(doc.balanceDue, doc.currency) : '',
      size: 9,
      bold: true,
      color: owed ? DANGER : PAID,
    })
    if (owed && doc.dueDate) {
      text('Due', { right: formatDate(doc.dueDate, doc.timeZone), size: 6, color: MUTED })
    }
  }

  if (doc.notes) {
    rule()
    for (const line of wrap(doc.notes, font, 6, inner)) text(line, { size: 6, color: MUTED })
  }

  if (doc.signature) {
    rule()
    rows.push({ kind: 'signature', height: 2 })
    const who = doc.signature.signerName
      ? `Signed by ${doc.signature.signerName}`
      : 'Signature on file'
    text(who, { size: 6, center: true, color: MUTED })
  }

  rule()
  for (const line of wrap(doc.footer ?? 'Thank you for your business.', font, 6, inner)) {
    text(line, { size: 6, center: true, color: MUTED })
  }

  return { rows, height: rows.reduce((total, row) => total + row.height, 0) }
}

// ─── drawing helpers ─────────────────────────────────────────────────────────

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

function rightText(
  page: PDFPage,
  rawValue: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  color: ReturnType<typeof rgb>,
) {
  const value = toWinAnsi(rawValue)
  page.drawText(value, { x: x - font.widthOfTextAtSize(value, size), y, size, font, color })
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

  for (const paragraph of value.split('\n')) {
    let current = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= max) {
        current = candidate
        continue
      }

      if (current) lines.push(current)
      current = ''

      // A word wider than the line — a long URL, a part number, a note typed
      // without spaces — is broken across lines. Truncating it would silently
      // drop text from a document somebody relies on.
      if (font.widthOfTextAtSize(word, size) > max) {
        const chunks = breakWord(word, font, size, max)
        lines.push(...chunks.slice(0, -1))
        current = chunks[chunks.length - 1]
      } else {
        current = word
      }
    }
    lines.push(current)
  }

  return lines.filter((line) => line.length > 0)
}

function breakWord(word: string, font: PDFFont, size: number, max: number): string[] {
  const chunks: string[] = []
  let current = ''

  for (const character of word) {
    if (current && font.widthOfTextAtSize(current + character, size) > max) {
      chunks.push(current)
      current = character
    } else {
      current += character
    }
  }
  if (current) chunks.push(current)

  return chunks.length > 0 ? chunks : ['']
}

/**
 * Logos are optional and come from configuration, so a broken or hostile URL
 * must degrade to "no logo" rather than fail the document. Only data URLs are
 * read: fetching an arbitrary configured URL server-side would make the PDF
 * renderer into a request forwarder.
 */
async function embedLogo(pdf: PDFDocument, url: string | null) {
  if (!url || !url.startsWith('data:image/')) return null
  try {
    const base64 = url.slice(url.indexOf(',') + 1)
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'))
    return url.startsWith('data:image/jpeg') || url.startsWith('data:image/jpg')
      ? await pdf.embedJpg(bytes)
      : await pdf.embedPng(bytes)
  } catch {
    return null
  }
}

async function embedPng(pdf: PDFDocument, bytes: Uint8Array) {
  try {
    return await pdf.embedPng(bytes)
  } catch {
    return null
  }
}

// ─── formatting ──────────────────────────────────────────────────────────────

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash', CHECK: 'Check', CARD: 'Card', ACH: 'ACH', OTHER: 'Other', CREDIT: 'Credit',
}

function methodLabel(method: string): string {
  return METHOD_LABELS[method] ?? method
}

function contactLine(party: DocumentParty): string | null {
  return [party.phone, party.email].filter(Boolean).join(' · ') || null
}

function money(value: string, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(value))
}

function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso))
}

function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(new Date(iso))
}
