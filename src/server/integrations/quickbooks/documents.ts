import { m, round2, toAmountString } from '@/server/domain/money'
import { readTaxSnapshot, type TaxSnapshot } from '@/server/domain/taxSnapshot'
import { toQboAmount } from './sync/reconcile'
import type { QuickBooksSettings } from './settings'
import type {
  QboCreditMemo,
  QboCustomer,
  QboInvoice,
  QboItem,
  QboJournalEntry,
  QboPayment,
  QboRefundReceipt,
  QboSalesLine,
  QboSalesReceipt,
  QboTxnTaxDetail,
  Ref,
} from './types'

/**
 * Turning posted SnackLoad documents into QuickBooks payloads (docs/08 §7).
 *
 * Every figure here comes off the document's own snapshot. Nothing reads a
 * current product price, a current customer tax setting or a current cost — the
 * whole point of the Phase 7.5 and hardening work was to make that possible,
 * and reintroducing a live lookup here would undo it silently (docs/02 §M4).
 *
 * Pure functions, no I/O: the syncers resolve references and then call these,
 * so a payload can be asserted in a unit test without a database.
 */

/** A date as QuickBooks wants it: a calendar day, no time, no zone. */
export function qboDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/**
 * The line's tax code.
 *
 * Under Automated Sales Tax the company's own code is used and `TotalTax`
 * overrides the figure; otherwise QuickBooks' plain TAX/NON codes. Either way
 * the line says whether the goods were taxable **when they were sold**, which
 * is a fact the snapshot carries and today's settings do not.
 */
function lineTaxCode(settings: QuickBooksSettings, taxable: boolean): Ref | undefined {
  if (settings.tax.automatedSalesTaxEnabled) {
    return settings.tax.taxCodeRef
      ? { value: settings.tax.taxCodeRef.id, name: settings.tax.taxCodeRef.name }
      : undefined
  }
  return { value: taxable ? 'TAX' : 'NON' }
}

/**
 * Tax stated, not recomputed (§8).
 *
 * `TxnTaxCodeRef` is what signals to QuickBooks that the `TotalTax` below is an
 * intentional override rather than a suggestion. Without it an AST company
 * substitutes its own figure, the totals diverge, and the sync is marked as
 * needing attention rather than accepted — which is correct, but avoidable.
 */
function txnTaxDetail(settings: QuickBooksSettings, taxTotal: string): QboTxnTaxDetail | undefined {
  const total = m(taxTotal)
  if (total.isZero() && !settings.tax.automatedSalesTaxEnabled) return undefined

  return {
    ...(settings.tax.taxCodeRef
      ? { TxnTaxCodeRef: { value: settings.tax.taxCodeRef.id, name: settings.tax.taxCodeRef.name } }
      : {}),
    TotalTax: toQboAmount(toAmountString(total)),
  }
}

export type LineSource = {
  productId: string
  descriptionSnapshot: string
  uomLabelSnapshot: string
  quantity: number
  unitPrice: string
  lineSubtotal: string
  discountAmount: string
  taxable: boolean
}

/**
 * Item lines at gross, with the discount as its own line.
 *
 * Sending a reduced `Amount` alongside `Qty × UnitPrice` invites QuickBooks to
 * recompute one of the three. A separate discount line is QuickBooks' own model
 * for it and keeps `Qty × UnitPrice = Amount` true on every item line — which
 * is also what makes the document readable to a bookkeeper.
 *
 * Quantity is in the **unit that was sold**, not base units, with the unit named
 * in the description. Three cases at $19.50 reads as three cases at $19.50; the
 * base-unit count would read as 36 at $19.50 and be wrong by an order of
 * magnitude in a column somebody scans.
 */
export function salesLines(
  lines: LineSource[],
  itemRefs: Map<string, Ref>,
  settings: QuickBooksSettings,
): { lines: QboSalesLine[]; discountTotal: string } {
  const built: QboSalesLine[] = []
  let discount = m(0)

  for (const line of lines) {
    const ref = itemRefs.get(line.productId)
    if (!ref) throw new Error(`No QuickBooks item mapped for product ${line.productId}.`)
    discount = discount.plus(m(line.discountAmount))

    built.push({
      Amount: toQboAmount(line.lineSubtotal),
      DetailType: 'SalesItemLineDetail',
      Description: `${line.descriptionSnapshot} — ${line.quantity} × ${line.uomLabelSnapshot}`,
      SalesItemLineDetail: {
        ItemRef: ref,
        Qty: line.quantity,
        UnitPrice: toQboAmount(line.unitPrice),
        ...(lineTaxCode(settings, line.taxable) ? { TaxCodeRef: lineTaxCode(settings, line.taxable)! } : {}),
      },
    })
  }

  return { lines: built, discountTotal: toAmountString(round2(discount)) }
}

/** The discount line, where there is one. Positive amount; QuickBooks subtracts it. */
export function discountLine(
  discountTotal: string,
  settings: QuickBooksSettings,
): QboSalesLine[] {
  if (!m(discountTotal).greaterThan(0)) return []
  const account = settings.accounts.returnsAndDiscounts
  return [
    {
      Amount: toQboAmount(discountTotal),
      DetailType: 'DiscountLineDetail',
      Description: 'Discount',
      // Typed as a sales line for convenience; the detail below is what
      // QuickBooks reads, and an absent account ref falls back to the company's
      // own "Discounts given".
      SalesItemLineDetail: undefined as never,
      DiscountLineDetail: {
        PercentBased: false,
        ...(account ? { DiscountAccountRef: { value: account.id, name: account.name } } : {}),
      },
    } as unknown as QboSalesLine,
  ]
}

/** The SnackLoad reference a bookkeeper needs to find the document here. */
function privateNote(settings: QuickBooksSettings, parts: (string | null | undefined)[]): string | undefined {
  if (!settings.documents.referenceInPrivateNote) return undefined
  const note = parts.filter(Boolean).join(' · ')
  return note || undefined
}

// ─── customers and items ─────────────────────────────────────────────────────

export type CustomerSource = {
  name: string
  accountNumber: string
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  phone: string | null
  email: string | null
}

export function buildCustomer(source: CustomerSource, existing?: { Id: string; SyncToken: string }): QboCustomer {
  return {
    ...(existing ? { Id: existing.Id, SyncToken: existing.SyncToken } : {}),
    /**
     * QuickBooks requires DisplayName to be unique in the company, and two
     * stores really can be called "Marathon". The account number disambiguates
     * without becoming identity — identity is the mapping row (docs/07 §1a).
     */
    DisplayName: `${source.name} (${source.accountNumber})`,
    CompanyName: source.name,
    ...(source.email ? { PrimaryEmailAddr: { Address: source.email } } : {}),
    ...(source.phone ? { PrimaryPhone: { FreeFormNumber: source.phone } } : {}),
    BillAddr: {
      ...(source.addressLine1 ? { Line1: source.addressLine1 } : {}),
      ...(source.addressLine2 ? { Line2: source.addressLine2 } : {}),
      ...(source.city ? { City: source.city } : {}),
      ...(source.state ? { CountrySubDivisionCode: source.state } : {}),
      ...(source.postalCode ? { PostalCode: source.postalCode } : {}),
    },
    Active: true,
  }
}

export function buildItem(
  source: { name: string; sku: string; taxable: boolean },
  settings: QuickBooksSettings,
  existing?: { Id: string; SyncToken: string },
): QboItem {
  const income = settings.accounts.salesIncome
  if (!income) throw new Error('No sales income account has been chosen for QuickBooks.')

  return {
    ...(existing ? { Id: existing.Id, SyncToken: existing.SyncToken } : {}),
    Name: source.name,
    Sku: source.sku,
    Description: source.name,
    // Non-inventory, always: SnackLoad owns stock (docs/07 §3).
    Type: 'NonInventory',
    IncomeAccountRef: { value: income.id, name: income.name },
    Taxable: source.taxable,
    Active: true,
  }
}

// ─── sales ───────────────────────────────────────────────────────────────────

export type SaleSource = {
  saleNumber: string
  occurredAt: Date
  dueDate: Date | null
  subtotal: string
  discountTotal: string
  taxTotal: string
  total: string
  notes: string | null
  taxJson: unknown
  items: LineSource[]
}

export type BuiltDocument<T> = {
  payload: T
  /** What the reconciliation check must find on the QuickBooks copy. */
  expected: { total: string; tax: string }
  /** Whether the tax figure came from a snapshot or from a legacy row (§9). */
  taxProvenance: 'SNAPSHOT' | 'LEGACY'
}

function taxProvenanceOf(taxJson: unknown): { snapshot: TaxSnapshot | null; provenance: 'SNAPSHOT' | 'LEGACY' } {
  const snapshot = readTaxSnapshot(taxJson)
  return { snapshot, provenance: snapshot ? 'SNAPSHOT' : 'LEGACY' }
}

/**
 * The legacy note (§9).
 *
 * A document posted before the tax snapshot existed carries a total and a tax
 * amount and nothing that explains them. We send the amounts — they are real
 * and they are what was charged — and we say on the document that the detail is
 * not available, rather than inventing a rate and a jurisdiction that would
 * look authoritative and be a guess.
 */
const LEGACY_TAX_NOTE = 'Tax detail not recorded (posted before SnackLoad captured tax provenance)'

function taxNote(snapshot: TaxSnapshot | null): string | undefined {
  if (!snapshot) return LEGACY_TAX_NOTE
  if (snapshot.exempt) {
    return `Tax exempt${snapshot.exemptId ? ` · certificate ${snapshot.exemptId}` : ''}`
  }
  if (!snapshot.name) return undefined
  return `Tax: ${snapshot.name}${snapshot.jurisdiction ? ` (${snapshot.jurisdiction})` : ''}`
}

export function buildInvoice(
  sale: SaleSource,
  refs: { customer: Ref; items: Map<string, Ref> },
  settings: QuickBooksSettings,
): BuiltDocument<QboInvoice> {
  const { snapshot, provenance } = taxProvenanceOf(sale.taxJson)
  const { lines, discountTotal } = salesLines(sale.items, refs.items, settings)

  return {
    payload: {
      ...(settings.documents.sendDocumentNumbers ? { DocNumber: sale.saleNumber } : {}),
      CustomerRef: refs.customer,
      TxnDate: qboDate(sale.occurredAt),
      ...(sale.dueDate ? { DueDate: qboDate(sale.dueDate) } : {}),
      Line: [...lines, ...discountLine(discountTotal, settings)],
      ...(txnTaxDetail(settings, sale.taxTotal) ? { TxnTaxDetail: txnTaxDetail(settings, sale.taxTotal)! } : {}),
      ...(privateNote(settings, [sale.saleNumber, taxNote(snapshot), sale.notes])
        ? { PrivateNote: privateNote(settings, [sale.saleNumber, taxNote(snapshot), sale.notes])! }
        : {}),
    },
    expected: { total: sale.total, tax: sale.taxTotal },
    taxProvenance: provenance,
  }
}

export function buildSalesReceipt(
  sale: SaleSource,
  refs: { customer: Ref; items: Map<string, Ref> },
  settings: QuickBooksSettings,
  paymentMethod?: Ref,
): BuiltDocument<QboSalesReceipt> {
  const invoice = buildInvoice(sale, refs, settings)
  // A sales receipt has no due date: nothing was ever owed.
  const rest = { ...invoice.payload, DueDate: undefined }
  delete rest.DueDate
  const deposit = settings.accounts.undepositedFunds

  return {
    payload: {
      ...rest,
      ...(paymentMethod ? { PaymentMethodRef: paymentMethod } : {}),
      ...(deposit ? { DepositToAccountRef: { value: deposit.id, name: deposit.name } } : {}),
    },
    expected: invoice.expected,
    taxProvenance: invoice.taxProvenance,
  }
}

// ─── payments ────────────────────────────────────────────────────────────────

export type PaymentSource = {
  receivedAt: Date
  amount: string
  method: string
  checkNumber: string | null
  referenceNumber: string | null
  /** One per allocation, already resolved to QuickBooks invoice ids. */
  allocations: { invoiceExternalId: string; amount: string; saleNumber: string }[]
}

export function buildPayment(
  payment: PaymentSource,
  refs: { customer: Ref },
  settings: QuickBooksSettings,
): BuiltDocument<QboPayment> {
  const deposit = settings.accounts.undepositedFunds

  return {
    payload: {
      CustomerRef: refs.customer,
      TxnDate: qboDate(payment.receivedAt),
      TotalAmt: toQboAmount(payment.amount),
      ...(deposit ? { DepositToAccountRef: { value: deposit.id, name: deposit.name } } : {}),
      ...(payment.checkNumber || payment.referenceNumber
        ? { PaymentRefNum: payment.checkNumber ?? payment.referenceNumber! }
        : {}),
      // One line per allocation, each linked to the invoice it settles. A
      // payment split across three invoices is three lines, not a lump the
      // bookkeeper has to apply by hand (§7).
      Line: payment.allocations.map((allocation) => ({
        Amount: toQboAmount(allocation.amount),
        LinkedTxn: [{ TxnId: allocation.invoiceExternalId, TxnType: 'Invoice' }],
      })),
      ...(privateNote(settings, [
        `Payment for ${payment.allocations.map((a) => a.saleNumber).join(', ')}`,
        `Method: ${payment.method}`,
      ])
        ? {
            PrivateNote: privateNote(settings, [
              `Payment for ${payment.allocations.map((a) => a.saleNumber).join(', ')}`,
              `Method: ${payment.method}`,
            ])!,
          }
        : {}),
    },
    expected: { total: payment.amount, tax: '0.00' },
    taxProvenance: 'SNAPSHOT',
  }
}

// ─── credits and refunds ─────────────────────────────────────────────────────

export type CreditMemoSource = {
  number: string
  issuedAt: Date
  taxTotal: string
  amount: string
  notes: string | null
  taxJson: unknown
  /** The return that produced it, where there was one (§7). */
  returnNumber: string | null
  saleNumber: string | null
  items: LineSource[]
}

export function buildCreditMemo(
  credit: CreditMemoSource,
  refs: { customer: Ref; items: Map<string, Ref> },
  settings: QuickBooksSettings,
): BuiltDocument<QboCreditMemo> {
  const { snapshot, provenance } = taxProvenanceOf(credit.taxJson)
  const { lines, discountTotal } = salesLines(credit.items, refs.items, settings)

  // The physical return has no QuickBooks document of its own — its money is
  // this credit (docs/07 §5). The return number rides in the note so somebody
  // reconciling can find the goods document in SnackLoad.
  const note = privateNote(settings, [
    credit.number,
    credit.returnNumber ? `Return ${credit.returnNumber}` : null,
    credit.saleNumber ? `against ${credit.saleNumber}` : null,
    taxNote(snapshot),
    credit.notes,
  ])

  return {
    payload: {
      ...(settings.documents.sendDocumentNumbers ? { DocNumber: credit.number } : {}),
      CustomerRef: refs.customer,
      TxnDate: qboDate(credit.issuedAt),
      Line: [...lines, ...discountLine(discountTotal, settings)],
      ...(txnTaxDetail(settings, credit.taxTotal) ? { TxnTaxDetail: txnTaxDetail(settings, credit.taxTotal)! } : {}),
      ...(note ? { PrivateNote: note } : {}),
    },
    expected: { total: credit.amount, tax: credit.taxTotal },
    taxProvenance: provenance,
  }
}

/**
 * Applying a credit to an invoice (§7).
 *
 * QuickBooks represents this as a **zero-total Payment** whose single line
 * links both the credit memo and the invoice. It is not a cash movement and
 * must not be modelled as one: syncing the credit memo alone and hoping
 * QuickBooks applies it to the right invoice is exactly the assumption §18
 * forbids, and QuickBooks' own default is oldest-first, which is not always
 * where SnackLoad put it.
 */
export function buildCreditApplication(
  args: {
    creditMemoExternalId: string
    invoiceExternalId: string
    amount: string
    appliedAt: Date
    creditNumber: string
    saleNumber: string
  },
  refs: { customer: Ref },
  settings: QuickBooksSettings,
): BuiltDocument<QboPayment> {
  const note = privateNote(settings, [
    `${args.creditNumber} applied to ${args.saleNumber}`,
  ])

  return {
    payload: {
      CustomerRef: refs.customer,
      TxnDate: qboDate(args.appliedAt),
      // Zero: no money moved. The line's links are the whole content.
      TotalAmt: 0,
      Line: [
        {
          Amount: toQboAmount(args.amount),
          LinkedTxn: [
            { TxnId: args.invoiceExternalId, TxnType: 'Invoice' },
            { TxnId: args.creditMemoExternalId, TxnType: 'CreditMemo' },
          ],
        },
      ],
      ...(note ? { PrivateNote: note } : {}),
    },
    expected: { total: '0.00', tax: '0.00' },
    taxProvenance: 'SNAPSHOT',
  }
}

export type RefundSource = {
  refundNumber: string
  issuedAt: Date
  amount: string
  method: string
  referenceNumber: string | null
  creditNumber: string
  /** Lines copied from the credit being paid out, so the economics match. */
  items: LineSource[]
  taxTotal: string
  taxJson: unknown
}

export function buildRefundReceipt(
  refund: RefundSource,
  refs: { customer: Ref; items: Map<string, Ref> },
  settings: QuickBooksSettings,
): BuiltDocument<QboRefundReceipt> {
  const { snapshot, provenance } = taxProvenanceOf(refund.taxJson)
  const { lines, discountTotal } = salesLines(refund.items, refs.items, settings)
  const account = settings.accounts.refundClearing ?? settings.accounts.undepositedFunds

  const note = privateNote(settings, [
    refund.refundNumber,
    `Refund of ${refund.creditNumber}`,
    `Method: ${refund.method}`,
    taxNote(snapshot),
  ])

  return {
    payload: {
      ...(settings.documents.sendDocumentNumbers ? { DocNumber: refund.refundNumber } : {}),
      CustomerRef: refs.customer,
      TxnDate: qboDate(refund.issuedAt),
      Line: [...lines, ...discountLine(discountTotal, settings)],
      ...(txnTaxDetail(settings, refund.taxTotal) ? { TxnTaxDetail: txnTaxDetail(settings, refund.taxTotal)! } : {}),
      ...(account ? { DepositToAccountRef: { value: account.id, name: account.name } } : {}),
      ...(refund.referenceNumber ? { PaymentRefNum: refund.referenceNumber } : {}),
      ...(note ? { PrivateNote: note } : {}),
    },
    expected: { total: refund.amount, tax: refund.taxTotal },
    taxProvenance: provenance,
  }
}

// ─── COGS ────────────────────────────────────────────────────────────────────

/**
 * The periodic COGS journal (docs/07 §3, §10).
 *
 * One entry per period, debiting cost of goods sold and crediting the inventory
 * asset. Not one per sale line, and not a stock movement: QuickBooks does not
 * own where the cases are, and pretending otherwise produces two sets of
 * inventory figures that disagree within a week.
 */
export function buildCogsJournal(
  batch: {
    id: string
    periodStart: Date
    periodEnd: Date
    totalCogs: string
    salesCogs: string
    returnCogs: string
    saleCount: number
    returnCount: number
  },
  settings: QuickBooksSettings,
): BuiltDocument<QboJournalEntry> {
  const cogs = settings.accounts.costOfGoodsSold
  const inventory = settings.accounts.inventoryAsset
  if (!cogs || !inventory) {
    throw new Error('The COGS and inventory asset accounts have not been chosen for QuickBooks.')
  }

  const amount = toQboAmount(batch.totalCogs)
  const period = `${qboDate(batch.periodStart)} to ${qboDate(batch.periodEnd)}`

  return {
    payload: {
      TxnDate: qboDate(batch.periodEnd),
      Line: [
        {
          Amount: amount,
          DetailType: 'JournalEntryLineDetail',
          Description: `Cost of goods sold ${period}`,
          JournalEntryLineDetail: {
            PostingType: 'Debit',
            AccountRef: { value: cogs.id, name: cogs.name },
          },
        },
        {
          Amount: amount,
          DetailType: 'JournalEntryLineDetail',
          Description: `Inventory relieved ${period}`,
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { value: inventory.id, name: inventory.name },
          },
        },
      ],
      PrivateNote:
        `SnackLoad COGS batch ${batch.id} · ${period} · ` +
        `${batch.saleCount} sales (${batch.salesCogs}) less ${batch.returnCount} returns (${batch.returnCogs})`,
    },
    // A journal entry's "total" in QuickBooks is one side of it.
    expected: { total: batch.totalCogs, tax: '0.00' },
    taxProvenance: 'SNAPSHOT',
  }
}

// ─── reversals ───────────────────────────────────────────────────────────────

/**
 * Reversing what QuickBooks cannot void (docs/08 §17).
 *
 * Intuit documents `operation=void` for **Invoice, SalesReceipt, Payment and
 * BillPayment only**. For a credit memo, a refund receipt or a journal entry
 * the only verb on offer is *delete*, which removes the record outright. That
 * is not what SnackLoad means by a void, and it is not something to do to
 * somebody's books on our initiative.
 *
 * So those three are reversed with a compensating action instead:
 *
 *  - a **credit memo** and a **refund receipt** are reduced to zero and marked,
 *    keeping the document, its number and its history, with nothing left on it
 *    to apply or to bank;
 *  - a **journal entry** gets a second, opposite entry — the textbook reversal,
 *    and the only one that leaves both halves visible to an accountant.
 */

/**
 * Strips the fields QuickBooks derives.
 *
 * An update echoes the document we read back, and that copy carries `TotalAmt`,
 * `Balance`, `RemainingCredit` and `void` — all of which QuickBooks computes.
 * Sending them back is at best ignored and at worst believed: the first version
 * of this zeroed every line and then handed QuickBooks the old total alongside,
 * so the document read as unchanged.
 */
function withoutDerived<T extends Record<string, unknown>>(document: T): T {
  const copy = { ...document }
  delete copy.TotalAmt
  delete copy.Balance
  delete copy.RemainingCredit
  delete copy.void
  return copy
}

/** Zeroes a sales-style document in place, keeping every line for the record. */
function zeroLines(lines: QboSalesLine[]): QboSalesLine[] {
  return lines.map((line) => ({
    ...line,
    Amount: 0,
    ...(line.SalesItemLineDetail
      ? { SalesItemLineDetail: { ...line.SalesItemLineDetail, UnitPrice: 0 } }
      : {}),
  }))
}

export function buildVoidedCreditMemo(
  existing: QboCreditMemo,
  reason: string,
): BuiltDocument<QboCreditMemo> {
  return {
    payload: {
      ...withoutDerived(existing),
      Line: zeroLines(existing.Line ?? []),
      // The tax goes with the merchandise it was charged on.
      ...(existing.TxnTaxDetail ? { TxnTaxDetail: { ...existing.TxnTaxDetail, TotalTax: 0 } } : {}),
      PrivateNote: appendVoidNote(existing.PrivateNote, reason),
    },
    expected: { total: '0.00', tax: '0.00' },
    taxProvenance: 'SNAPSHOT',
  }
}

export function buildVoidedRefundReceipt(
  existing: QboRefundReceipt,
  reason: string,
): BuiltDocument<QboRefundReceipt> {
  return {
    payload: {
      ...withoutDerived(existing),
      Line: zeroLines(existing.Line ?? []),
      ...(existing.TxnTaxDetail ? { TxnTaxDetail: { ...existing.TxnTaxDetail, TotalTax: 0 } } : {}),
      PrivateNote: appendVoidNote(existing.PrivateNote, reason),
    },
    expected: { total: '0.00', tax: '0.00' },
    taxProvenance: 'SNAPSHOT',
  }
}

/**
 * The opposite entry. Debits become credits and the amounts stay the same, so
 * the period nets to nothing and both entries remain readable — which is what
 * an accountant expects to find, rather than a journal that has disappeared.
 */
export function buildReversingJournal(
  original: { periodStart: Date; periodEnd: Date; totalCogs: string; batchId: string },
  settings: QuickBooksSettings,
  reason: string,
): BuiltDocument<QboJournalEntry> {
  const forward = buildCogsJournal(
    {
      id: original.batchId,
      periodStart: original.periodStart,
      periodEnd: original.periodEnd,
      totalCogs: original.totalCogs,
      salesCogs: original.totalCogs,
      returnCogs: '0.00',
      saleCount: 0,
      returnCount: 0,
    },
    settings,
  )

  return {
    payload: {
      TxnDate: forward.payload.TxnDate,
      Line: forward.payload.Line.map((line) => ({
        ...line,
        Description: `Reversal — ${line.Description ?? ''}`.trim(),
        JournalEntryLineDetail: {
          ...line.JournalEntryLineDetail,
          PostingType:
            line.JournalEntryLineDetail.PostingType === 'Debit' ? 'Credit' : 'Debit',
        },
      })),
      PrivateNote: `Reverses SnackLoad COGS batch ${original.batchId} · ${reason}`,
    },
    expected: { total: original.totalCogs, tax: '0.00' },
    taxProvenance: 'SNAPSHOT',
  }
}

function appendVoidNote(existing: string | undefined, reason: string): string {
  const note = `VOIDED IN SNACKLOAD: ${reason}`.slice(0, 900)
  return existing ? `${existing} · ${note}` : note
}
