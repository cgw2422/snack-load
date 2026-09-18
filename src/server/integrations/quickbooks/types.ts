/**
 * The QuickBooks Online adapter boundary (docs/08 §2).
 *
 * Everything Intuit-specific lives behind `QuickBooksClient`. The sync engine,
 * the services and the UI import from this file and never from `client.ts`, so
 * the whole of Phase 8 can be exercised against a deterministic fake and a
 * change to Intuit's API is a change to one module.
 *
 * Verified against Intuit's current documentation in September 2026:
 *
 *  - Accounting API minor version **75**. Versions 1–74 were deprecated in
 *    August 2025 and any lower value is treated as 75, so it is sent explicitly
 *    rather than left to a default that has moved before.
 *  - Every mutating call carries a **`requestid`** query parameter. Intuit
 *    replays the original response for a repeated request id instead of
 *    creating a second document — the primitive the whole duplicate-prevention
 *    story rests on (§5).
 *  - Updates carry a **`SyncToken`**; a stale one is rejected rather than
 *    silently overwriting somebody's edit.
 *  - Errors arrive as a `Fault` envelope with a list of `Error` objects, each
 *    with `code`, `Message` and `Detail`.
 */

export type QuickBooksEnvironment = 'SANDBOX' | 'PRODUCTION'

/** Minor version pinned explicitly. See the note above. */
export const MINOR_VERSION = '75'

export const API_BASE: Record<QuickBooksEnvironment, string> = {
  SANDBOX: 'https://sandbox-quickbooks.api.intuit.com',
  PRODUCTION: 'https://quickbooks.api.intuit.com',
}

/** Intuit's OAuth endpoints are the same for both environments. */
export const OAUTH = {
  authorize: 'https://appcenter.intuit.com/connect/oauth2',
  token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revoke: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
} as const

/**
 * Accounting access only. We never ask for payments, and never for the identity
 * scopes: the connection is to a company, not to a person, and a scope we do
 * not need is a scope a breach can use.
 */
export const SCOPES = ['com.intuit.quickbooks.accounting'] as const

// ─── tokens ──────────────────────────────────────────────────────────────────

export type TokenSet = {
  accessToken: string
  refreshToken: string
  /** Seconds. Intuit issues 3600 today; we store the absolute expiry. */
  expiresIn: number
  /** Seconds until the refresh token itself dies. */
  refreshExpiresIn: number
  scope: string
  realmId?: string
}

// ─── errors ──────────────────────────────────────────────────────────────────

/**
 * Why a call failed, decided by the adapter so the sync engine never has to
 * parse Intuit's error text (§27). `retryable` is the only question the worker
 * asks; `category` is what the issues screen shows a human.
 */
export type QuickBooksErrorCategory =
  | 'TRANSIENT'
  | 'VALIDATION'
  | 'MAPPING'
  | 'AUTHORIZATION'
  | 'EXTERNAL_CONFLICT'

export class QuickBooksError extends Error {
  constructor(
    readonly category: QuickBooksErrorCategory,
    message: string,
    readonly options: {
      /** Intuit's own code, verbatim, for support and for the issues list. */
      code?: string
      detail?: string
      httpStatus?: number
      /** Seconds to wait, from a 429's `Retry-After`. */
      retryAfterSeconds?: number
    } = {},
  ) {
    super(message)
    this.name = 'QuickBooksError'
  }

  get retryable(): boolean {
    return this.category === 'TRANSIENT'
  }
}

// ─── entity shapes ───────────────────────────────────────────────────────────
//
// Only the fields we send or read. Deliberately not a full model of Intuit's
// schema: an unused field is one more thing to keep true.

export type Ref = { value: string; name?: string }

export type QboCustomer = {
  Id?: string
  SyncToken?: string
  DisplayName: string
  CompanyName?: string
  PrimaryEmailAddr?: { Address: string }
  PrimaryPhone?: { FreeFormNumber: string }
  BillAddr?: {
    Line1?: string
    Line2?: string
    City?: string
    CountrySubDivisionCode?: string
    PostalCode?: string
  }
  Notes?: string
  Active?: boolean
}

export type QboItem = {
  Id?: string
  SyncToken?: string
  Name: string
  Sku?: string
  Description?: string
  /**
   * Always `NonInventory`. SnackLoad owns stock across a warehouse and several
   * trucks on a moving average; QuickBooks inventory is FIFO with one quantity
   * on hand and cannot represent that (docs/07 §3).
   */
  Type: 'NonInventory' | 'Service'
  IncomeAccountRef: Ref
  Taxable?: boolean
  Active?: boolean
}

export type QboTaxLine = {
  Amount: number
  DetailType: 'TaxLineDetail'
  TaxLineDetail: {
    TaxRateRef: Ref
    PercentBased?: boolean
    TaxPercent?: number
    NetAmountTaxable?: number
  }
}

/**
 * Tax stated explicitly rather than recomputed (§14).
 *
 * `TotalTax` is honoured by QuickBooks — including under Automated Sales Tax —
 * but only when `TxnTaxCodeRef` is present to signal the intent. Without it,
 * AST silently substitutes its own figure and the two systems disagree.
 */
export type QboTxnTaxDetail = {
  TxnTaxCodeRef?: Ref
  TotalTax: number
  TaxLine?: QboTaxLine[]
}

export type QboSalesLine = {
  Amount: number
  DetailType: 'SalesItemLineDetail'
  Description?: string
  SalesItemLineDetail: {
    ItemRef: Ref
    UnitPrice?: number
    Qty?: number
    TaxCodeRef?: Ref
  }
}

export type QboInvoice = {
  Id?: string
  SyncToken?: string
  DocNumber?: string
  CustomerRef: Ref
  TxnDate: string
  DueDate?: string
  Line: QboSalesLine[]
  TxnTaxDetail?: QboTxnTaxDetail
  PrivateNote?: string
  CustomerMemo?: { value: string }
  TotalAmt?: number
  Balance?: number
  /** Present on a voided document. */
  void?: boolean
}

export type QboSalesReceipt = Omit<QboInvoice, 'DueDate' | 'Balance'> & {
  PaymentMethodRef?: Ref
  DepositToAccountRef?: Ref
}

export type QboLinkedTxn = { TxnId: string; TxnType: string }

export type QboPayment = {
  Id?: string
  SyncToken?: string
  /** Present once QuickBooks has voided it. */
  void?: boolean
  CustomerRef: Ref
  TxnDate: string
  TotalAmt: number
  PaymentMethodRef?: Ref
  DepositToAccountRef?: Ref
  PaymentRefNum?: string
  PrivateNote?: string
  Line?: {
    Amount: number
    LinkedTxn: QboLinkedTxn[]
  }[]
}

export type QboCreditMemo = {
  Id?: string
  SyncToken?: string
  /** Set when we have reduced it to nothing; QuickBooks has no void here. */
  void?: boolean
  DocNumber?: string
  CustomerRef: Ref
  TxnDate: string
  Line: QboSalesLine[]
  TxnTaxDetail?: QboTxnTaxDetail
  PrivateNote?: string
  TotalAmt?: number
  RemainingCredit?: number
}

export type QboRefundReceipt = {
  Id?: string
  SyncToken?: string
  /** Set when we have reduced it to nothing; QuickBooks has no void here. */
  void?: boolean
  DocNumber?: string
  CustomerRef: Ref
  TxnDate: string
  Line: QboSalesLine[]
  TxnTaxDetail?: QboTxnTaxDetail
  PaymentMethodRef?: Ref
  DepositToAccountRef?: Ref
  PrivateNote?: string
  TotalAmt?: number
}

export type QboJournalLine = {
  Amount: number
  DetailType: 'JournalEntryLineDetail'
  Description?: string
  JournalEntryLineDetail: {
    PostingType: 'Debit' | 'Credit'
    AccountRef: Ref
  }
}

export type QboJournalEntry = {
  Id?: string
  SyncToken?: string
  DocNumber?: string
  TxnDate: string
  Line: QboJournalLine[]
  PrivateNote?: string
  TotalAmt?: number
}

export type QboAccount = {
  Id: string
  Name: string
  AccountType: string
  AccountSubType?: string
  Classification?: string
  Active?: boolean
  CurrentBalance?: number
}

export type QboCompanyInfo = {
  CompanyName: string
  LegalName?: string
  Country?: string
}

/**
 * Whether the company computes its own sales tax (§14).
 *
 * Read once at connect time and re-read when the tax policy is reviewed. An AST
 * company still honours `TotalTax`, but only with `TxnTaxCodeRef` set, so the
 * answer changes what we send rather than whether we sync.
 */
export type QboTaxService = {
  automatedSalesTaxEnabled: boolean
  /** The company's default sales tax code, where one is discoverable. */
  defaultTaxCodeRef: Ref | null
  taxRates: { id: string; name: string; rate: number }[]
}

// ─── the interface ───────────────────────────────────────────────────────────

/**
 * What the rest of SnackLoad is allowed to know about QuickBooks.
 *
 * Every mutating method takes a `requestId`: the caller owns idempotency,
 * because the caller is what survives a crash. The adapter never mints one.
 */
export type QuickBooksClient = {
  readonly realmId: string
  readonly environment: QuickBooksEnvironment

  getCompanyInfo(): Promise<QboCompanyInfo>
  listAccounts(): Promise<QboAccount[]>
  getTaxService(): Promise<QboTaxService>

  findCustomerByDisplayName(displayName: string): Promise<QboCustomer | null>
  createCustomer(input: QboCustomer, requestId: string): Promise<QboCustomer>
  updateCustomer(input: QboCustomer, requestId: string): Promise<QboCustomer>
  getCustomer(id: string): Promise<QboCustomer | null>

  findItemByName(name: string): Promise<QboItem | null>
  createItem(input: QboItem, requestId: string): Promise<QboItem>
  updateItem(input: QboItem, requestId: string): Promise<QboItem>
  getItem(id: string): Promise<QboItem | null>

  /**
   * **Void is not available on every object** (docs/08 §17).
   *
   * Intuit documents `operation=void` for Invoice, SalesReceipt, Payment and
   * BillPayment only. CreditMemo, RefundReceipt and JournalEntry have no void —
   * the only verb QuickBooks offers them is delete, which destroys the record.
   * So those three are reversed by a compensating action instead, and the
   * interface deliberately has no `voidCreditMemo`-shaped method for them.
   */
  createInvoice(input: QboInvoice, requestId: string): Promise<QboInvoice>
  updateInvoice(input: QboInvoice, requestId: string): Promise<QboInvoice>
  getInvoice(id: string): Promise<QboInvoice | null>
  voidInvoice(id: string, syncToken: string, requestId: string): Promise<QboInvoice>

  createSalesReceipt(input: QboSalesReceipt, requestId: string): Promise<QboSalesReceipt>
  updateSalesReceipt(input: QboSalesReceipt, requestId: string): Promise<QboSalesReceipt>
  getSalesReceipt(id: string): Promise<QboSalesReceipt | null>
  voidSalesReceipt(id: string, syncToken: string, requestId: string): Promise<QboSalesReceipt>

  createPayment(input: QboPayment, requestId: string): Promise<QboPayment>
  updatePayment(input: QboPayment, requestId: string): Promise<QboPayment>
  getPayment(id: string): Promise<QboPayment | null>
  voidPayment(id: string, syncToken: string, requestId: string): Promise<QboPayment>

  createCreditMemo(input: QboCreditMemo, requestId: string): Promise<QboCreditMemo>
  updateCreditMemo(input: QboCreditMemo, requestId: string): Promise<QboCreditMemo>
  getCreditMemo(id: string): Promise<QboCreditMemo | null>

  createRefundReceipt(input: QboRefundReceipt, requestId: string): Promise<QboRefundReceipt>
  updateRefundReceipt(input: QboRefundReceipt, requestId: string): Promise<QboRefundReceipt>
  getRefundReceipt(id: string): Promise<QboRefundReceipt | null>

  createJournalEntry(input: QboJournalEntry, requestId: string): Promise<QboJournalEntry>
  updateJournalEntry(input: QboJournalEntry, requestId: string): Promise<QboJournalEntry>
  getJournalEntry(id: string): Promise<QboJournalEntry | null>
}
