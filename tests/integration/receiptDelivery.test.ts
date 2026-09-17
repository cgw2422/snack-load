import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import { receiveStock } from '@/server/services/receiving.service'
import { createVehicle, moveTruckStock } from '@/server/services/truckload.service'
import { checkout, voidSale } from '@/server/services/sale.service'
import {
  emailReceipt,
  listDeliveries,
  shareLinkForReceipt,
  textReceipt,
} from '@/server/services/delivery.service'
import {
  createShareLink,
  resolveShareToken,
  revokeShareLinks,
} from '@/server/services/shareLink.service'
import {
  getPublicReceiptDocument,
  getReceiptDocument,
} from '@/server/documents/receiptDocument'
import { renderReceiptPdf } from '@/server/documents/receiptPdf'
import { PDFDocument } from 'pdf-lib'
import { renderReceiptEmail, renderReceiptSms } from '@/server/documents/receiptMessage'
import { resetProviders, setProvidersForTesting } from '@/server/messaging'
import type { EmailMessage, EmailProvider, SmsMessage, SmsProvider } from '@/server/messaging'
import {
  addMember,
  createCustomer,
  createProduct,
  createTestOrg,
  type TestOrg,
} from '../helpers'

async function pageHeight(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes)
  return pdf.getPage(0).getSize().height
}

/** A provider that records what it was handed and answers however the test says. */
class FakeEmail implements EmailProvider {
  readonly name = 'fake-email'
  sent: EmailMessage[] = []
  outcome: { ok: true; messageId: string } | { ok: false; error: string } = {
    ok: true,
    messageId: 'fake-1',
  }

  async send(message: EmailMessage) {
    this.sent.push(message)
    return this.outcome
  }
}

class FakeSms implements SmsProvider {
  readonly name = 'fake-sms'
  sent: SmsMessage[] = []
  outcome: { ok: true; messageId: string } | { ok: false; error: string } = {
    ok: true,
    messageId: 'fake-sms-1',
  }

  async send(message: SmsMessage) {
    this.sent.push(message)
    return this.outcome
  }
}

/**
 * Receipt delivery (spec §25).
 *
 * Two properties carry most of the weight here: a document is built from what
 * was posted, not from what the records say today; and a delivery failure is
 * only a delivery failure — it never reaches back into the sale.
 */
describe('receipt delivery', () => {
  let org: TestOrg
  let runner: Awaited<ReturnType<typeof addMember>>
  let customerId: string
  let product: Awaited<ReturnType<typeof createProduct>>
  let saleId: string
  let email: FakeEmail
  let sms: FakeSms

  beforeEach(async () => {
    org = await createTestOrg()
    runner = await addMember(org, 'runner', { firstName: 'Mike', lastName: 'Donnelly' })

    const customer = await createCustomer(org.organizationId)
    customerId = customer.id
    await db(org.ownerCtx).customer.update({
      where: { id: customerId },
      data: { email: 'orders@joesmarathon.test', phone: '(555) 201-4488' },
    })

    product = await createProduct(org.organizationId, {
      unitsPerCase: 12, casePrice: '19.50', unitPrice: '2.29', costPerBaseUnit: '1.200000',
    })

    await receiveStock(org.ownerCtx, {
      warehouseLocationId: org.warehouseLocationId,
      idempotencyKey: randomUUID(),
      lines: [
        { productId: product.id, productUomId: product.caseUomId, quantity: 40, unitCost: '14.40' },
      ],
    })

    const vehicle = await createVehicle(org.ownerCtx, {
      name: 'Truck #2', truckNumber: '2', active: true, assignedUserId: runner.userId,
    })
    await db(org.ownerCtx).membership.updateMany({
      where: { userId: runner.userId },
      data: { defaultVehicleId: vehicle.id },
    })
    await moveTruckStock(org.ownerCtx, {
      vehicleId: vehicle.id,
      warehouseLocationId: org.warehouseLocationId,
      direction: 'LOAD',
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 20 }],
    })

    const sale = await checkout(runner.ctx, {
      customerId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 2 }],
      payment: { method: 'CASH', amount: '10.00' },
      notes: 'Leave with the morning clerk.',
    })
    saleId = sale.saleId

    email = new FakeEmail()
    sms = new FakeSms()
    setProvidersForTesting({ email, sms })
  })

  afterEach(async () => {
    resetProviders()
    await unsafeDb.organization.deleteMany({ where: { id: org.organizationId } })
  })

  describe('the document', () => {
    it('reads the store and company as they were, not as they are now', async () => {
      await db(org.ownerCtx).customer.update({
        where: { id: customerId },
        data: { name: 'Sold To Somebody Else LLC', addressLine1: '999 New Place' },
      })
      await db(org.ownerCtx).organization.update({
        where: { id: org.organizationId },
        data: { name: 'Renamed Distributors' },
      })

      const doc = await getReceiptDocument(org.ownerCtx, saleId)

      expect(doc.headerFromSnapshot).toBe(true)
      expect(doc.billTo.name).toBe("Joe's Marathon")
      expect(doc.billTo.addressLines.join(' ')).toContain('123 Main St.')
      expect(doc.issuer.name).not.toBe('Renamed Distributors')
    })

    it('carries the figures that were posted', async () => {
      const doc = await getReceiptDocument(org.ownerCtx, saleId)

      expect(doc.lines).toHaveLength(1)
      // Two cases at $19.50. The demo tax rate is not on this test org, so the
      // total is the subtotal.
      expect(doc.subtotal).toBe('39.00')
      expect(doc.total).toBe('39.00')
      expect(doc.amountPaid).toBe('10.00')
      expect(doc.balanceDue).toBe('29.00')
      expect(doc.notes).toBe('Leave with the morning clerk.')
    })

    it('prints an amount column that adds up to the subtotal', async () => {
      const multi = await checkout(runner.ctx, {
        customerId,
        idempotencyKey: randomUUID(),
        lines: [
          { productId: product.id, productUomId: product.caseUomId, quantity: 3 },
          { productId: product.id, productUomId: product.baseUomId, quantity: 5 },
        ],
      })
      const doc = await getReceiptDocument(org.ownerCtx, multi.saleId)

      // What a clerk does with a pen: add the right-hand column and compare it
      // with the Subtotal. Line totals carry tax, so they are the wrong figure
      // for that column.
      const column = doc.lines.reduce((n, line) => n + Number(line.lineSubtotal), 0)
      expect(column.toFixed(2)).toBe(doc.subtotal)
    })

    it('does not count a reversed payment as money the store paid', async () => {
      const before = await getReceiptDocument(org.ownerCtx, saleId)
      expect(before.payments).toHaveLength(1)

      const payment = await db(org.ownerCtx).payment.findFirstOrThrow({
        where: { customerId },
        select: { id: true },
      })
      const { reversePayment } = await import('@/server/services/payment.service')
      await reversePayment(org.ownerCtx, payment.id, 'Bad bill')

      const after = await getReceiptDocument(org.ownerCtx, saleId)
      expect(after.payments).toHaveLength(0)
    })
  })

  describe('pdf', () => {
    it('renders a full page and a thermal roll', async () => {
      const doc = await getReceiptDocument(org.ownerCtx, saleId, { includeSignatureImage: true })

      for (const layout of ['full', 'thermal'] as const) {
        const bytes = await renderReceiptPdf(doc, layout)
        expect(bytes.byteLength).toBeGreaterThan(500)
        expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-')
      }
    })

    it('sizes the thermal roll to its content instead of a fixed page', async () => {
      const short = await getReceiptDocument(org.ownerCtx, saleId)

      const longSale = await checkout(runner.ctx, {
        customerId,
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 1 }],
        notes: [
          'Delivered to the back door because the front cooler was being serviced.',
          'The clerk asked us to come back Thursday with two more cases of the',
          'lemonade and to leave the invoice with the morning shift instead of',
          'the owner, who is away until the end of the month.',
          // An unbroken run has to wrap too, not vanish.
          'REF-' + 'A9'.repeat(60),
        ].join(' '),
      })
      const long = await getReceiptDocument(org.ownerCtx, longSale.saleId)

      // Byte length is not height — compression hides the difference. Measure
      // the page the printer would actually feed.
      const shortHeight = await pageHeight(await renderReceiptPdf(short, 'thermal'))
      const longHeight = await pageHeight(await renderReceiptPdf(long, 'thermal'))

      // Six more lines of note is roughly 45pt of roll. The point is that the
      // page tracks the content rather than ejecting a fixed sheet.
      expect(longHeight).toBeGreaterThan(shortHeight + 30)
      expect(shortHeight).toBeLessThan(792)
    })

    it('still renders after the sale is voided', async () => {
      await voidSale(org.ownerCtx, saleId, 'Duplicate ticket')
      const doc = await getReceiptDocument(org.ownerCtx, saleId)

      expect(doc.void?.reason).toBe('Duplicate ticket')
      const bytes = await renderReceiptPdf(doc, 'full')
      expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-')
    })
  })

  describe('email', () => {
    it('sends to the address on file, attaches the PDF, and logs it', async () => {
      const result = await emailReceipt(org.ownerCtx, { saleId })

      expect(result.status).toBe('SENT')
      expect(result.destination).toBe('orders@joesmarathon.test')
      expect(email.sent[0].attachments?.[0].contentType).toBe('application/pdf')
      expect(email.sent[0].html).toContain(result.shareUrl)

      const [log] = await listDeliveries(org.ownerCtx, saleId)
      expect(log).toMatchObject({ channel: 'EMAIL', status: 'SENT', provider: 'fake-email' })

      const receipt = await db(org.ownerCtx).receipt.findFirstOrThrow({ where: { saleId } })
      expect(receipt.emailedAt).not.toBeNull()
    })

    it('sends to a typed-in address instead when one is given', async () => {
      await emailReceipt(org.ownerCtx, { saleId, to: 'owner@elsewhere.test' })
      expect(email.sent[0].to).toBe('owner@elsewhere.test')
    })

    it('records a failure and leaves the sale exactly as it was', async () => {
      email.outcome = { ok: false, error: 'Recipient address is suppressed' }
      const before = await db(org.ownerCtx).sale.findFirstOrThrow({ where: { id: saleId } })

      const result = await emailReceipt(org.ownerCtx, { saleId })

      expect(result.status).toBe('FAILED')
      expect(result.failureReason).toBe('Recipient address is suppressed')

      const after = await db(org.ownerCtx).sale.findFirstOrThrow({ where: { id: saleId } })
      expect(after.status).toBe(before.status)
      expect(after.total.toString()).toBe(before.total.toString())
      expect(after.balanceDue.toString()).toBe(before.balanceDue.toString())

      const [log] = await listDeliveries(org.ownerCtx, saleId)
      expect(log).toMatchObject({ status: 'FAILED', failureReason: 'Recipient address is suppressed' })

      // A failed send must not claim the receipt went out.
      const receipt = await db(org.ownerCtx).receipt.findFirstOrThrow({ where: { saleId } })
      expect(receipt.emailedAt).toBeNull()
    })

    it('refuses rather than guessing when there is no address anywhere', async () => {
      await db(org.ownerCtx).customer.update({ where: { id: customerId }, data: { email: null } })
      const fresh = await checkout(runner.ctx, {
        customerId,
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, productUomId: product.caseUomId, quantity: 1 }],
      })

      await expect(emailReceipt(org.ownerCtx, { saleId: fresh.saleId })).rejects.toThrow(
        /no email address/i,
      )
      expect(email.sent).toHaveLength(0)
    })

    it('leads with the void when the sale was voided', async () => {
      await voidSale(org.ownerCtx, saleId, 'Wrong store')
      const doc = await getReceiptDocument(org.ownerCtx, saleId)
      const body = renderReceiptEmail(doc, { shareUrl: 'https://example.test/r/x' })

      expect(body.subject).toMatch(/^VOIDED/)
      expect(body.text).toMatch(/voided/i)
      expect(renderReceiptSms(doc, 'https://example.test/r/x')).toMatch(/VOIDED/)
    })
  })

  describe('text', () => {
    it('sends a link rather than an attachment', async () => {
      const result = await textReceipt(org.ownerCtx, { saleId })

      expect(result.status).toBe('SENT')
      expect(sms.sent[0].body).toContain(result.shareUrl)
      expect(sms.sent[0].to).toBe('5552014488')

      const [log] = await listDeliveries(org.ownerCtx, saleId)
      expect(log).toMatchObject({ channel: 'SMS', status: 'SENT' })
    })

    it('records a failure without touching the sale', async () => {
      sms.outcome = { ok: false, error: 'Landline cannot receive messages' }
      const result = await textReceipt(org.ownerCtx, { saleId })

      expect(result.status).toBe('FAILED')
      const receipt = await db(org.ownerCtx).receipt.findFirstOrThrow({ where: { saleId } })
      expect(receipt.textedAt).toBeNull()
    })
  })

  describe('share links', () => {
    it('opens exactly one receipt for whoever holds the token', async () => {
      const { token } = await createShareLink(org.ownerCtx, saleId)

      const resolved = await resolveShareToken(token)
      expect(resolved).toMatchObject({ organizationId: org.organizationId, saleId })

      const doc = await getPublicReceiptDocument(resolved!.organizationId, resolved!.saleId)
      expect(doc.receiptNumber).toBeTruthy()
      expect(doc.lines).toHaveLength(1)
    })

    it('stores only a digest, so the table does not hand out working links', async () => {
      const { token } = await createShareLink(org.ownerCtx, saleId)
      const rows = await db(org.ownerCtx).receiptShareLink.findMany({
        select: { tokenHash: true },
      })

      expect(token.length).toBeGreaterThanOrEqual(43)
      for (const row of rows) expect(row.tokenHash).not.toBe(token)
    })

    it('refuses a guess, a revoked link and an expired one alike', async () => {
      expect(await resolveShareToken('not-a-real-token-at-all-0000')).toBeNull()

      const revoked = await createShareLink(org.ownerCtx, saleId)
      await revokeShareLinks(org.ownerCtx, saleId)
      expect(await resolveShareToken(revoked.token)).toBeNull()

      const expiring = await createShareLink(org.ownerCtx, saleId)
      await db(org.ownerCtx).receiptShareLink.update({
        where: { id: expiring.id },
        data: { expiresAt: new Date(Date.now() - 1000), revokedAt: null },
      })
      expect(await resolveShareToken(expiring.token)).toBeNull()
    })

    it('shows the void to somebody holding a link issued before it', async () => {
      const { token } = await createShareLink(org.ownerCtx, saleId)
      await voidSale(org.ownerCtx, saleId, 'Returned the whole order')

      const resolved = await resolveShareToken(token)
      const doc = await getPublicReceiptDocument(resolved!.organizationId, resolved!.saleId)

      expect(doc.status).toBe('VOIDED')
      expect(doc.void?.reason).toBe('Returned the whole order')
    })

    it('counts views without failing the read', async () => {
      const { id, token } = await createShareLink(org.ownerCtx, saleId)
      await resolveShareToken(token)
      await resolveShareToken(token)

      const row = await db(org.ownerCtx).receiptShareLink.findFirstOrThrow({ where: { id } })
      expect(row.viewCount).toBe(2)
      expect(row.lastViewedAt).not.toBeNull()
    })

    it('logs a link the share sheet minted', async () => {
      await shareLinkForReceipt(org.ownerCtx, saleId)
      const [log] = await listDeliveries(org.ownerCtx, saleId)
      expect(log).toMatchObject({ channel: 'LINK', status: 'SENT' })
    })
  })

  describe('who may send', () => {
    it('keeps a runner from reading another runner\'s delivery history', async () => {
      const other = await addMember(org, 'runner', { firstName: 'Sarah', lastName: 'Nguyen' })
      await expect(listDeliveries(other.ctx, saleId)).rejects.toThrow(/not found/i)
    })

    it('refuses a warehouse user, who has no business emailing invoices', async () => {
      const warehouse = await addMember(org, 'warehouse')
      await expect(emailReceipt(warehouse.ctx, { saleId })).rejects.toThrow()
    })
  })
})
