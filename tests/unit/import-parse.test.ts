import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { detectFormat, parseSpreadsheet, toCsv } from '@/server/import/parse'

const enc = (s: string) => new TextEncoder().encode(s)

describe('reading a file someone actually sent', () => {
  it('reads a plain CSV', async () => {
    const sheet = await parseSpreadsheet(
      'products.csv',
      enc('SKU,Name,Price\n1001,Takis Fuego,19.50\n1002,Doritos,20.40\n'),
    )
    expect(sheet.headers).toEqual(['SKU', 'Name', 'Price'])
    expect(sheet.rows).toHaveLength(2)
    expect(sheet.rows[0]).toEqual({ SKU: '1001', Name: 'Takis Fuego', Price: '19.50' })
  })

  it('skips a title row above the headings', async () => {
    // Exports routinely carry a company name and a date before the real header.
    const sheet = await parseSpreadsheet(
      'export.csv',
      enc('Valley Snack Distributors\nPrice list 09/16/2026\n\nSKU,Name,Price\n1001,Takis,19.50\n'),
    )
    expect(sheet.headers).toEqual(['SKU', 'Name', 'Price'])
    expect(sheet.headerRow).toBe(4)
    expect(sheet.rows).toHaveLength(1)
  })

  it('strips the BOM Excel writes, which would corrupt the first heading', async () => {
    const sheet = await parseSpreadsheet('bom.csv', enc('﻿SKU,Name\n1001,Takis\n'))
    expect(sheet.headers[0]).toBe('SKU')
  })

  it('trims whitespace around headings', async () => {
    const sheet = await parseSpreadsheet('spaces.csv', enc('  SKU  , Name \n1001,Takis\n'))
    expect(sheet.headers).toEqual(['SKU', 'Name'])
    expect(sheet.rows[0].SKU).toBe('1001')
  })

  it('keeps two identically named columns apart', async () => {
    const sheet = await parseSpreadsheet('dupes.csv', enc('SKU,Price,Price\n1001,19.50,2.29\n'))
    expect(sheet.headers).toEqual(['SKU', 'Price', 'Price (2)'])
    expect(sheet.rows[0]['Price']).toBe('19.50')
    expect(sheet.rows[0]['Price (2)']).toBe('2.29')
  })

  it('drops blank rows in the middle of the data', async () => {
    const sheet = await parseSpreadsheet('gaps.csv', enc('SKU,Name\n1001,Takis\n\n\n1002,Doritos\n'))
    expect(sheet.rows).toHaveLength(2)
  })

  it('handles quoted commas in a product name', async () => {
    const sheet = await parseSpreadsheet(
      'quoted.csv',
      enc('SKU,Name\n1001,"Takis Fuego, 9.9oz"\n'),
    )
    expect(sheet.rows[0].Name).toBe('Takis Fuego, 9.9oz')
  })

  it('refuses a file with no headings at all', async () => {
    await expect(parseSpreadsheet('empty.csv', enc('\n\n'))).rejects.toThrow(/No column headings/i)
  })

  it('reads an xlsx workbook', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Products')
    sheet.addRow(['SKU', 'Name', 'Case Price'])
    sheet.addRow(['1001', 'Takis Fuego', 19.5])
    sheet.addRow(['1002', 'Monster Energy', 33.5])
    const buffer = await workbook.xlsx.writeBuffer()

    const parsed = await parseSpreadsheet('products.xlsx', new Uint8Array(buffer as ArrayBuffer))
    expect(parsed.headers).toEqual(['SKU', 'Name', 'Case Price'])
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[1]).toEqual({ SKU: '1002', Name: 'Monster Energy', 'Case Price': '33.5' })
  })

  it('reads a formula cell as its value, not its formula', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Products')
    sheet.addRow(['SKU', 'Case Price'])
    const row = sheet.addRow(['1001', null])
    row.getCell(2).value = { formula: 'A1*2', result: 39 }
    const buffer = await workbook.xlsx.writeBuffer()

    const parsed = await parseSpreadsheet('formula.xlsx', new Uint8Array(buffer as ArrayBuffer))
    expect(parsed.rows[0]['Case Price']).toBe('39')
  })

  it('identifies the format from the bytes, not the file name', () => {
    expect(detectFormat('anything.csv', enc('SKU,Name'))).toBe('csv')
    // A zip signature is an xlsx even if it was renamed to .csv.
    expect(detectFormat('renamed.csv', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('xlsx')
  })

  it('tells someone plainly that a legacy .xls will not work', () => {
    expect(() =>
      detectFormat('old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
    ).toThrow(/save it as .xlsx/i)
  })
})

describe('writing a CSV back out', () => {
  it('quotes what needs quoting', () => {
    expect(toCsv(['A', 'B'], [['plain', 'has,comma']])).toBe('A,B\r\nplain,"has,comma"')
    expect(toCsv(['A'], [['say "hi"']])).toBe('A\r\n"say ""hi"""')
  })

  it('defuses a cell that a spreadsheet would run as a formula', () => {
    // Otherwise an exported value beginning with = executes when the file opens.
    expect(toCsv(['A'], [['=1+1']])).toBe("A\r\n'=1+1")
    expect(toCsv(['A'], [['@SUM(A1)']])).toBe("A\r\n'@SUM(A1)")
    expect(toCsv(['A'], [['-2+3']])).toBe("A\r\n'-2+3")
  })
})
