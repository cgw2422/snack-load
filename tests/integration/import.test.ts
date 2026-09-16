import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import * as importService from '@/server/services/import.service'
import { findBalanceDrift } from '@/server/services/inventory.service'
import { createTestOrg, type TestOrg } from '../helpers'

const enc = (s: string) => new TextEncoder().encode(s)

/**
 * The import is the first thing a real distributor touches — they arrive with a
 * spreadsheet, not with an empty catalog. The rule that matters most is spec §8's
 * "support updating existing products via CSV … without creating duplicates".
 */
describe('product import', () => {
  let org: TestOrg

  beforeEach(async () => {
    org = await createTestOrg()
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  async function runImport(csv: string, overrides: Partial<{ mode: 'CREATE_ONLY' | 'UPDATE_ONLY' | 'UPSERT' }> = {}) {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'PRODUCTS',
      fileName: 'products.csv',
      bytes: enc(csv),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: overrides.mode ?? 'UPSERT',
      matchKey: 'SKU',
    })
    const result = await importService.commitImportJob(org.ownerCtx, job.jobId)
    return { job, preview, result }
  }

  const HEADER = 'Item #,Item Description,Brand,Pack Size,Your Cost,Sell Price,Each Price,Bar Code,Current Cases,Current Units,Category,Vendor'

  it("maps a distributor's own column names onto ours", async () => {
    const { job } = await runImport(
      `${HEADER}\n1001,Takis Fuego,Barcel,12,14.40,19.50,2.29,757528005207,18,7,Chips,Barcel USA\n`,
    )
    expect(job.mapping.sku).toBe('Item #')
    expect(job.mapping.name).toBe('Item Description')
    expect(job.mapping.caseQuantity).toBe('Pack Size')

    const product = await db(org.ownerCtx).product.findFirst({
      where: { sku: '1001' },
      include: { uoms: true, category: true, supplier: true },
    })
    expect(product?.name).toBe('Takis Fuego')
    expect(product?.brand).toBe('Barcel')
    expect(product?.category?.name).toBe('Chips')
    expect(product?.supplier?.name).toBe('Barcel USA')
  })

  it('divides a case cost into a per-base-unit cost', async () => {
    await runImport(`${HEADER}\n1001,Takis,Barcel,12,14.40,19.50,2.29,,0,0,Chips,Barcel USA\n`)
    const product = await db(org.ownerCtx).product.findFirst({ where: { sku: '1001' } })
    // 14.40 / 12 = 1.20 exactly.
    expect(product?.costPerBaseUnit.toString()).toBe('1.2')
  })

  it('creates the base unit and the case as separate UoMs', async () => {
    await runImport(`${HEADER}\n1001,Takis,Barcel,12,14.40,19.50,2.29,757528005207,0,0,Chips,Barcel USA\n`)
    const uoms = await db(org.ownerCtx).productUom.findMany({
      where: { product: { sku: '1001' } },
      orderBy: { baseUnitsPerUom: 'asc' },
    })
    expect(uoms).toHaveLength(2)
    expect(uoms[0]).toMatchObject({ code: 'EACH', baseUnitsPerUom: 1, isBase: true })
    expect(uoms[0].price.toString()).toBe('2.29')
    expect(uoms[1]).toMatchObject({ code: 'CASE', baseUnitsPerUom: 12, isDefaultSaleUom: true })
    expect(uoms[1].price.toString()).toBe('19.5')
  })

  it('posts opening stock through the ledger, not straight onto a balance', async () => {
    await runImport(`${HEADER}\n1001,Takis,Barcel,12,14.40,19.50,2.29,,18,7,Chips,Barcel USA\n`)

    const lines = await db(org.ownerCtx).inventoryTransactionLine.findMany({
      where: { product: { sku: '1001' } },
    })
    expect(lines).toHaveLength(1)
    // 18 cases of 12, plus 7 loose bags.
    expect(lines[0].quantityDelta).toBe(223)

    const balance = await db(org.ownerCtx).inventoryBalance.findFirst({
      where: { product: { sku: '1001' } },
    })
    expect(balance?.quantity).toBe(223)
    expect(await findBalanceDrift(unsafeDb, org.organizationId)).toEqual([])
  })

  it('updates an existing product instead of duplicating it', async () => {
    await runImport(`${HEADER}\n1001,Takis Fuego,Barcel,12,14.40,19.50,2.29,,10,0,Chips,Barcel USA\n`)

    // The price list comes back with new prices and nothing else.
    const { result } = await runImport('Item #,Sell Price,Your Cost\n1001,21.00,15.60\n')

    expect(result.imported).toBe(1)
    expect(await db(org.ownerCtx).product.count()).toBe(1)

    const product = await db(org.ownerCtx).product.findFirst({
      where: { sku: '1001' },
      include: { uoms: { where: { code: 'CASE' } } },
    })
    expect(product?.uoms[0].price.toString()).toBe('21')
    // A cost update with no pack size column must still divide by the pack size
    // the product already has: 15.60 / 12 = 1.30, not 15.60 per bag.
    expect(product?.costPerBaseUnit.toString()).toBe('1.3')
    // Name and brand were not in the second file and must survive untouched.
    expect(product?.name).toBe('Takis Fuego')
    expect(product?.brand).toBe('Barcel')
  })

  it('does not re-post opening stock when a product is updated', async () => {
    await runImport(`${HEADER}\n1001,Takis,Barcel,12,14.40,19.50,2.29,,10,0,Chips,Barcel USA\n`)
    await runImport(`${HEADER}\n1001,Takis,Barcel,12,14.40,19.50,2.29,,10,0,Chips,Barcel USA\n`)

    const balance = await db(org.ownerCtx).inventoryBalance.findFirst({
      where: { product: { sku: '1001' } },
    })
    // 120, not 240: the second run was an update, not a new receipt.
    expect(balance?.quantity).toBe(120)
  })

  it('recognises a product by UPC when the SKU has changed', async () => {
    await runImport(`${HEADER}\n1001,Takis,Barcel,12,14.40,19.50,2.29,757528005207,0,0,Chips,Barcel USA\n`)
    await runImport('Item #,Bar Code,Sell Price\nNEW-SKU,757528005207,22.00\n')

    expect(await db(org.ownerCtx).product.count()).toBe(1)
    const product = await db(org.ownerCtx).product.findFirst({})
    expect(product?.sku).toBe('NEW-SKU')
  })

  it('flags a SKU that appears twice in the same file', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'PRODUCTS',
      fileName: 'dupes.csv',
      bytes: enc('Item #,Item Description,Sell Price\n1001,Takis,19.50\n1001,Takis Again,20.00\n'),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'SKU',
    })

    expect(preview.errorRows).toBe(1)
    const bad = preview.rows.find((r) => r.status === 'ERROR')
    expect(bad?.messages[0].message).toMatch(/appears more than once/i)

    await importService.commitImportJob(org.ownerCtx, job.jobId)
    expect(await db(org.ownerCtx).product.count()).toBe(1)
  })

  it('refuses to overwrite in create-only mode and says why', async () => {
    await runImport(`${HEADER}\n1001,Takis,Barcel,12,14.40,19.50,2.29,,0,0,Chips,Barcel USA\n`)

    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'PRODUCTS',
      fileName: 'again.csv',
      bytes: enc('Item #,Item Description,Sell Price\n1001,Something Else,99.00\n'),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'CREATE_ONLY',
      matchKey: 'SKU',
    })

    expect(preview.errorRows).toBe(1)
    expect(preview.rows[0].messages[0].message).toMatch(/already exists/i)
  })

  it('skips a row with no match in update-only mode', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'PRODUCTS',
      fileName: 'update.csv',
      bytes: enc('Item #,Sell Price\nGHOST,19.50\n'),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPDATE_ONLY',
      matchKey: 'SKU',
    })
    expect(preview.rows[0].action).toBe('SKIP')

    const result = await importService.commitImportJob(org.ownerCtx, job.jobId)
    expect(result.imported).toBe(0)
    expect(await db(org.ownerCtx).product.count()).toBe(0)
  })

  it('blocks a row missing a required field', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'PRODUCTS',
      fileName: 'missing.csv',
      bytes: enc('Item #,Item Description,Sell Price\n1001,,19.50\n1002,Doritos,20.40\n'),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'SKU',
    })
    expect(preview.errorRows).toBe(1)

    await importService.commitImportJob(org.ownerCtx, job.jobId)
    // The good row still imports; one bad row does not abandon the file.
    expect(await db(org.ownerCtx).product.count()).toBe(1)
  })

  it('warns when a selling price is below cost rather than silently accepting it', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'PRODUCTS',
      fileName: 'loss.csv',
      bytes: enc('Item #,Item Description,Your Cost,Sell Price\n1001,Takis,20.00,18.00\n'),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'SKU',
    })
    expect(preview.warningRows).toBe(1)
    expect(preview.rows[0].messages[0].message).toMatch(/below case cost/i)
    // A warning does not block the row.
    expect(preview.rows[0].action).toBe('CREATE')
  })

  it('offers an error CSV carrying the original columns', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'PRODUCTS',
      fileName: 'bad.csv',
      bytes: enc('Item #,Item Description,Sell Price\n1001,,19.50\n'),
    })
    await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'SKU',
    })

    const csv = await importService.buildErrorCsv(org.ownerCtx, job.jobId)
    expect(csv).toContain('Row,Problem,Item #,Item Description,Sell Price')
    expect(csv).toMatch(/Product Name is empty/)
  })

  it('lets a bad cell be fixed inline without re-uploading', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'PRODUCTS',
      fileName: 'fixme.csv',
      bytes: enc('Item #,Item Description,Sell Price\n1001,,19.50\n'),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'SKU',
    })
    expect(preview.rows[0].status).toBe('ERROR')

    await importService.patchImportRow(org.ownerCtx, job.jobId, preview.rows[0].id, {
      'Item Description': 'Takis Fuego',
    })

    const after = await importService.getImportPreview(org.ownerCtx, job.jobId)
    expect(after.rows[0].status).toBe('READY')
    expect(after.errorRows).toBe(0)

    await importService.commitImportJob(org.ownerCtx, job.jobId)
    expect(await db(org.ownerCtx).product.count()).toBe(1)
  })
})

describe('customer import', () => {
  let org: TestOrg

  beforeEach(async () => {
    org = await createTestOrg()
  })

  afterEach(async () => {
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  it('maps "Location" to the store name, as the spec asks', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'stores.csv',
      bytes: enc('Acct #,Location,Address,City,ST,Zip,Phone\n1001,Joe\'s Marathon,123 Main St.,Riverton,OH,44870,5551234567\n'),
    })
    expect(job.mapping.name).toBe('Location')

    await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'ACCOUNT_NUMBER',
    })
    await importService.commitImportJob(org.ownerCtx, job.jobId)

    const customer = await db(org.ownerCtx).customer.findFirst({})
    expect(customer?.name).toBe("Joe's Marathon")
    expect(customer?.postalCode).toBe('44870')
    expect(customer?.phone).toBe('(555) 123-4567')
  })

  it('will not silently create a route or a user from a spreadsheet cell', async () => {
    // The spec's example: Joe's Marathon | Tuesday | Mike.
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'routes.csv',
      bytes: enc("Acct #,Store Name,Route,Runner,Day\n1001,Joe's Marathon,Tuesday Route,Mike,Tuesday\n"),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'ACCOUNT_NUMBER',
    })

    expect(preview.rows[0].status).toBe('WARNING')
    expect(preview.rows[0].messages.map((mm) => mm.message).join(' ')).toMatch(/matched to a route/i)
    expect(preview.unresolved.map((u) => u.kind).sort()).toEqual(['route', 'runner'])

    await importService.commitImportJob(org.ownerCtx, job.jobId)

    // The store imports; the route and the person do not appear from nowhere.
    expect(await db(org.ownerCtx).customer.count()).toBe(1)
    expect(await db(org.ownerCtx).routeTemplate.count()).toBe(0)
    expect(await db(org.ownerCtx).customerSchedule.count()).toBe(0)
  })

  it('does not ask about a route the company plainly already has', async () => {
    await db(org.ownerCtx).routeTemplate.create({
      data: { organizationId: org.organizationId, name: 'Route A', dayOfWeek: 'TUESDAY' },
    })

    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'known.csv',
      bytes: enc("Acct #,Store Name,City,Route,Day\n1001,Joe's Marathon,Riverton,Route A,Tue\n"),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'ACCOUNT_NUMBER',
    })

    expect(preview.unresolved).toEqual([])
    expect(preview.readyRows).toBe(1)
    expect(preview.warningRows).toBe(0)

    await importService.commitImportJob(org.ownerCtx, job.jobId)
    const schedule = await db(org.ownerCtx).customerSchedule.findFirst({})
    expect(schedule?.dayOfWeek).toBe('TUESDAY')
  })

  it('matches a runner by first name when only one person answers to it', async () => {
    const mike = await unsafeDb.user.create({
      data: {
        email: `mike-${Date.now()}@test.local`,
        passwordHash: 'x',
        firstName: 'Mike',
        lastName: 'Donnelly',
      },
      select: { id: true },
    })
    await unsafeDb.membership.create({
      data: {
        organizationId: org.organizationId,
        userId: mike.id,
        roleId: org.roleIds.runner,
      },
    })
    await db(org.ownerCtx).routeTemplate.create({
      data: {
        organizationId: org.organizationId,
        name: 'Route A',
        dayOfWeek: 'TUESDAY',
        defaultRunnerUserId: mike.id,
      },
    })

    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'runner.csv',
      bytes: enc("Acct #,Store Name,City,Runner\n1001,Joe's Marathon,Riverton,Mike\n"),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'ACCOUNT_NUMBER',
    })
    expect(preview.unresolved).toEqual([])

    await importService.commitImportJob(org.ownerCtx, job.jobId)
    const schedule = await db(org.ownerCtx).customerSchedule.findFirst({
      include: { routeTemplate: true },
    })
    expect(schedule?.routeTemplate.name).toBe('Route A')

    await unsafeDb.user.delete({ where: { id: mike.id } })
  })

  it('remembers what still needs deciding, so a reload still shows it', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'unknown.csv',
      bytes: enc("Acct #,Store Name,City,Route\n1001,Joe's Marathon,Riverton,Mystery Route\n"),
    })
    await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'ACCOUNT_NUMBER',
    })

    const reloaded = await importService.getImportPreview(org.ownerCtx, job.jobId)
    expect(reloaded.unresolved).toHaveLength(1)
    expect(reloaded.unresolved[0]).toMatchObject({ kind: 'route', value: 'Mystery Route' })
  })

  it('assigns the route and visit day once the reference is resolved', async () => {
    const route = await db(org.ownerCtx).routeTemplate.create({
      data: { organizationId: org.organizationId, name: 'Route A', dayOfWeek: 'MONDAY' },
      select: { id: true },
    })

    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'routes.csv',
      bytes: enc("Acct #,Store Name,Route,Day,Frequency\n1001,Joe's Marathon,Tuesday Route,Tue,every other week\n"),
    })
    await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'ACCOUNT_NUMBER',
      resolvedReferences: { 'route:tuesday route': route.id },
    })
    await importService.commitImportJob(org.ownerCtx, job.jobId)

    const schedule = await db(org.ownerCtx).customerSchedule.findFirst({})
    expect(schedule?.routeTemplateId).toBe(route.id)
    expect(schedule?.dayOfWeek).toBe('TUESDAY')
    expect(schedule?.frequency).toBe('BIWEEKLY')
  })

  it('generates an account number when the file has none', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'noacct.csv',
      bytes: enc("Store Name,City\nJoe's Marathon,Riverton\nSpeedway #214,Dover\n"),
    })
    await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'NAME',
    })
    await importService.commitImportJob(org.ownerCtx, job.jobId)

    const customers = await db(org.ownerCtx).customer.findMany({ orderBy: { accountNumber: 'asc' } })
    expect(customers).toHaveLength(2)
    expect(new Set(customers.map((c) => c.accountNumber)).size).toBe(2)
  })

  it('warns about a store with no address, because it cannot be routed', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'noaddr.csv',
      bytes: enc("Acct #,Store Name,Phone\n1001,Joe's Marathon,5551234567\n"),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'ACCOUNT_NUMBER',
    })
    expect(preview.rows[0].messages.map((mm) => mm.message).join(' ')).toMatch(/cannot be routed/i)
  })

  it('keeps a bad email out of the record but imports the store', async () => {
    const job = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'bademail.csv',
      bytes: enc("Acct #,Store Name,City,Email\n1001,Joe's Marathon,Riverton,not-an-email\n"),
    })
    const preview = await importService.validateImportJob(org.ownerCtx, job.jobId, {
      mapping: job.mapping,
      mode: 'UPSERT',
      matchKey: 'ACCOUNT_NUMBER',
    })
    expect(preview.warningRows).toBe(1)

    await importService.commitImportJob(org.ownerCtx, job.jobId)
    const customer = await db(org.ownerCtx).customer.findFirst({})
    expect(customer?.name).toBe("Joe's Marathon")
    expect(customer?.email).toBeNull()
  })

  it('re-imports without duplicating and without wiping unlisted columns', async () => {
    const first = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'stores.csv',
      bytes: enc("Acct #,Store Name,Address,City,Terms,Notes\n1001,Joe's Marathon,123 Main St.,Riverton,Net 30,Back door before 9am\n"),
    })
    await importService.validateImportJob(org.ownerCtx, first.jobId, {
      mapping: first.mapping, mode: 'UPSERT', matchKey: 'ACCOUNT_NUMBER',
    })
    await importService.commitImportJob(org.ownerCtx, first.jobId)

    const second = await importService.createImportJob(org.ownerCtx, {
      type: 'CUSTOMERS',
      fileName: 'limits.csv',
      bytes: enc('Acct #,Credit Limit\n1001,2500\n'),
    })
    await importService.validateImportJob(org.ownerCtx, second.jobId, {
      mapping: second.mapping, mode: 'UPSERT', matchKey: 'ACCOUNT_NUMBER',
    })
    await importService.commitImportJob(org.ownerCtx, second.jobId)

    expect(await db(org.ownerCtx).customer.count()).toBe(1)
    const customer = await db(org.ownerCtx).customer.findFirst({})
    expect(customer?.creditLimit?.toString()).toBe('2500')
    expect(customer?.notes).toBe('Back door before 9am')
    expect(customer?.paymentTermsCode).toBe('NET30')
  })
})

describe('import tenancy', () => {
  it('never lets one company import over another company\'s catalog', async () => {
    const alpha = await createTestOrg()
    const beta = await createTestOrg()

    for (const org of [alpha, beta]) {
      const job = await importService.createImportJob(org.ownerCtx, {
        type: 'PRODUCTS',
        fileName: 'p.csv',
        bytes: enc('SKU,Name,Price\n1001,Takis,19.50\n'),
      })
      await importService.validateImportJob(org.ownerCtx, job.jobId, {
        mapping: job.mapping, mode: 'UPSERT', matchKey: 'SKU',
      })
      await importService.commitImportJob(org.ownerCtx, job.jobId)
    }

    // Same SKU, two companies, two products.
    expect(await db(alpha.ownerCtx).product.count()).toBe(1)
    expect(await db(beta.ownerCtx).product.count()).toBe(1)

    const alphaProduct = await db(alpha.ownerCtx).product.findFirst({})
    const betaProduct = await db(beta.ownerCtx).product.findFirst({})
    expect(alphaProduct!.id).not.toBe(betaProduct!.id)

    await unsafeDb.organization.deleteMany({
      where: { id: { in: [alpha.organizationId, beta.organizationId] } },
    })
  })
})
