/**
 * The receipt as a document (spec §24, §25).
 *
 * Everything a printed, emailed or downloaded receipt needs, in one plain
 * value. It is assembled once by `getReceiptDocument` and handed to every
 * renderer — HTML, full-page PDF, thermal PDF — so the three can never tell the
 * store three different stories.
 *
 * Money is decimal strings throughout. Nothing here is recomputed from live
 * records: the figures are the ones posted with the sale, and the header is the
 * snapshot taken at the same moment (docs/02 §L5).
 */

export type DocumentParty = {
  name: string
  /** Company legal name, or a store's account number. */
  subtitle: string | null
  addressLines: string[]
  phone: string | null
  email: string | null
}

export type DocumentLine = {
  id: string
  name: string
  sku: string
  uomLabel: string
  quantity: number
  unitPrice: string
  lineSubtotal: string
  discountAmount: string
  taxAmount: string
  lineTotal: string
}

export type DocumentPayment = {
  method: string
  amount: string
  reference: string | null
}

export type ReceiptDocument = {
  saleId: string
  saleNumber: string
  receiptNumber: string
  /** COMPLETED or VOIDED. A voided document says so on its face. */
  status: string
  occurredAt: string
  issuedAt: string
  dueDate: string | null
  paymentTermsCode: string
  notes: string | null

  issuer: DocumentParty
  /** Absolute or data URL for the company logo, when one is configured. */
  logoUrl: string | null
  footer: string | null
  currency: string
  timeZone: string

  billTo: DocumentParty
  customerId: string
  soldByName: string

  lines: DocumentLine[]
  subtotal: string
  discountTotal: string
  taxTotal: string
  total: string
  amountPaid: string
  balanceDue: string
  payments: DocumentPayment[]

  signature: { signerName: string | null; capturedAt: string; imagePng: Uint8Array | null } | null

  void: { voidedAt: string; reason: string | null; voidedByName: string | null } | null

  /**
   * False when this sale predates the header snapshot and the issuer/bill-to
   * blocks were read from the live records instead. Renderers do not have to
   * care; it exists so the difference is never invisible to us.
   */
  headerFromSnapshot: boolean
}
