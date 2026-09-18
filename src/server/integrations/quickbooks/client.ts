import {
  API_BASE,
  MINOR_VERSION,
  QuickBooksError,
  type QboAccount,
  type QboCompanyInfo,
  type QboCreditMemo,
  type QboCustomer,
  type QboInvoice,
  type QboItem,
  type QboJournalEntry,
  type QboPayment,
  type QboRefundReceipt,
  type QboSalesReceipt,
  type QboTaxService,
  type QuickBooksClient,
  type QuickBooksEnvironment,
} from './types'

/**
 * The real Intuit HTTP adapter (docs/08 §2).
 *
 * The only file in SnackLoad that talks to Intuit. Three things it is careful
 * about, all verified against current documentation:
 *
 *  1. **`requestid` on every mutation.** Intuit replays the original response
 *     for a repeated request id rather than creating a second document. The
 *     caller supplies it and reuses it across retries; that is what makes a
 *     lost response safe (§5).
 *  2. **`minorversion=75` stated explicitly.** Minor versions 1–74 were
 *     deprecated in August 2025, and a default that moves under us would change
 *     field semantics without a deploy.
 *  3. **Errors classified here, not in the worker.** Intuit's `Fault` envelope
 *     is parsed once and turned into a `QuickBooksError` whose category decides
 *     whether a machine retries or a person is asked (§8).
 *
 * Rate limits at the time of writing: 500 requests per minute per company and
 * ten concurrent. A 429 carries `Retry-After`, which is honoured rather than
 * guessed at.
 */

export type ClientOptions = {
  realmId: string
  environment: QuickBooksEnvironment
  /** Fetched fresh by the caller, which owns refresh and rotation. */
  accessToken: string
  /** Injectable for tests that need to drive the transport itself. */
  fetchImpl?: typeof fetch
}

type Fault = {
  Fault?: {
    Error?: { Message?: string; Detail?: string; code?: string; element?: string }[]
    type?: string
  }
}

/** Intuit codes that mean "a person must change something", not "try again". */
const VALIDATION_CODES = new Set([
  '2500', // invalid reference id
  '6000', // business validation error
  '6140', // duplicate document number
  '6240', // duplicate name exists
  '2010', // required param missing
  '2020',
  '2030',
  '610', // object not found
])

/** Codes that mean a reference we sent points at nothing. */
const MAPPING_CODES = new Set(['610', '2500', '3100'])

export function classifyFault(httpStatus: number, body: string, retryAfter?: string): QuickBooksError {
  let parsed: Fault = {}
  try {
    parsed = JSON.parse(body) as Fault
  } catch {
    // Intuit occasionally answers a gateway failure with HTML. Fall through to
    // classification by status, which is the honest amount of information.
  }

  const first = parsed.Fault?.Error?.[0]
  const code = first?.code
  const message = first?.Message ?? `QuickBooks returned HTTP ${httpStatus}.`
  const detail = first?.Detail
  const faultType = parsed.Fault?.type

  const options = {
    code,
    detail,
    httpStatus,
    retryAfterSeconds: retryAfter ? Number(retryAfter) || undefined : undefined,
  }

  if (httpStatus === 401 || httpStatus === 403 || faultType === 'AUTHENTICATION') {
    return new QuickBooksError(
      'AUTHORIZATION',
      'QuickBooks refused the connection. It may have been disconnected in QuickBooks.',
      options,
    )
  }

  if (httpStatus === 429) {
    return new QuickBooksError('TRANSIENT', 'QuickBooks is rate limiting this company.', options)
  }

  if (httpStatus >= 500 || httpStatus === 408) {
    return new QuickBooksError('TRANSIENT', `QuickBooks is unavailable (HTTP ${httpStatus}).`, options)
  }

  // A stale SyncToken: somebody changed their copy since we read it. Surfaced,
  // never resolved by overwriting (§12).
  if (code === '5010' || /stale object|has been modified/i.test(`${message} ${detail ?? ''}`)) {
    return new QuickBooksError(
      'EXTERNAL_CONFLICT',
      'The QuickBooks copy of this document was changed since SnackLoad last read it.',
      options,
    )
  }

  if (code && MAPPING_CODES.has(code) && /account|item|customer|ref/i.test(`${message} ${detail ?? ''}`)) {
    return new QuickBooksError('MAPPING', detail ?? message, options)
  }

  if (code && VALIDATION_CODES.has(code)) {
    return new QuickBooksError('VALIDATION', detail ?? message, options)
  }

  if (httpStatus >= 400) {
    return new QuickBooksError('VALIDATION', detail ?? message, options)
  }

  return new QuickBooksError('TRANSIENT', message, options)
}

export function createQuickBooksClient(options: ClientOptions): QuickBooksClient {
  const doFetch = options.fetchImpl ?? fetch
  const base = `${API_BASE[options.environment]}/v3/company/${options.realmId}`

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; requestId?: string; query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(`${base}${path}`)
    url.searchParams.set('minorversion', MINOR_VERSION)
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)
    // The idempotency key. Same id, same document — however many times we ask.
    if (init.requestId) url.searchParams.set('requestid', init.requestId)

    let response: Response
    try {
      response = await doFetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      })
    } catch (cause) {
      // A connection that never completed. This is the dangerous case the
      // request id exists for: QuickBooks may well have created the document.
      throw new QuickBooksError('TRANSIENT', 'Could not reach QuickBooks.', {
        detail: cause instanceof Error ? cause.message : String(cause),
      })
    }

    const text = await response.text()
    if (!response.ok) {
      throw classifyFault(response.status, text, response.headers.get('retry-after') ?? undefined)
    }

    return (text ? JSON.parse(text) : {}) as T
  }

  /**
   * Reads go through the query endpoint. Used only for *discovery* — offering a
   * human a plausible match to confirm — never to decide identity on an ongoing
   * sync, which is always `ExternalMapping` (docs/07 §1a).
   */
  async function query<T>(statement: string, key: string): Promise<T[]> {
    const result = await call<{ QueryResponse?: Record<string, T[]> }>('GET', '/query', {
      query: { query: statement },
    })
    return result.QueryResponse?.[key] ?? []
  }

  /** QuickBooks rejects an unescaped apostrophe in a query literal. */
  const literal = (value: string) => `'${value.replace(/'/g, "\\'")}'`

  const create = <T>(entity: string, key: string) =>
    async (input: unknown, requestId: string): Promise<T> => {
      const result = await call<Record<string, T>>('POST', `/${entity}`, { body: input, requestId })
      return result[key]
    }

  const read = <T>(entity: string, key: string) =>
    async (id: string): Promise<T | null> => {
      try {
        const result = await call<Record<string, T>>('GET', `/${entity}/${id}`)
        return result[key] ?? null
      } catch (error) {
        if (error instanceof QuickBooksError && error.options.httpStatus === 404) return null
        throw error
      }
    }

  /**
   * Voiding. QuickBooks keeps the document and zeroes it, which is the closest
   * thing to SnackLoad's own rule that financial records are never deleted.
   * Payments and sales receipts void through the same `operation=void` verb.
   */
  const voidDoc = <T>(entity: string, key: string) =>
    async (id: string, syncToken: string, requestId: string): Promise<T> => {
      const result = await call<Record<string, T>>('POST', `/${entity}`, {
        body: { Id: id, SyncToken: syncToken },
        requestId,
        query: { operation: 'void' },
      })
      return result[key]
    }

  return {
    realmId: options.realmId,
    environment: options.environment,

    async getCompanyInfo() {
      const result = await call<{ CompanyInfo: QboCompanyInfo }>(
        'GET',
        `/companyinfo/${options.realmId}`,
      )
      return result.CompanyInfo
    },

    listAccounts: () =>
      query<QboAccount>('SELECT * FROM Account WHERE Active = true MAXRESULTS 1000', 'Account'),

    async getTaxService() {
      // Whether the company runs Automated Sales Tax changes what a transaction
      // must carry for our figure to survive (§14).
      const [preferences, rates] = await Promise.all([
        call<{ Preferences?: { TaxPrefs?: { PartnerTaxEnabled?: boolean; TaxGroupCodeRef?: { value: string } } } }>(
          'GET',
          '/preferences',
        ).catch(() => ({ Preferences: undefined })),
        query<{ Id: string; Name: string; RateValue?: number }>(
          'SELECT * FROM TaxRate MAXRESULTS 200',
          'TaxRate',
        ).catch(() => []),
      ])

      const prefs = preferences.Preferences?.TaxPrefs
      return {
        automatedSalesTaxEnabled: prefs?.PartnerTaxEnabled === true,
        defaultTaxCodeRef: prefs?.TaxGroupCodeRef ? { value: prefs.TaxGroupCodeRef.value } : null,
        taxRates: rates.map((r) => ({ id: r.Id, name: r.Name, rate: Number(r.RateValue ?? 0) })),
      } satisfies QboTaxService
    },

    async findCustomerByDisplayName(displayName) {
      const rows = await query<QboCustomer>(
        `SELECT * FROM Customer WHERE DisplayName = ${literal(displayName)} MAXRESULTS 5`,
        'Customer',
      )
      return rows[0] ?? null
    },
    createCustomer: create<QboCustomer>('customer', 'Customer'),
    updateCustomer: create<QboCustomer>('customer', 'Customer'),
    getCustomer: read<QboCustomer>('customer', 'Customer'),

    async findItemByName(name) {
      const rows = await query<QboItem>(
        `SELECT * FROM Item WHERE Name = ${literal(name)} MAXRESULTS 5`,
        'Item',
      )
      return rows[0] ?? null
    },
    createItem: create<QboItem>('item', 'Item'),
    updateItem: create<QboItem>('item', 'Item'),
    getItem: read<QboItem>('item', 'Item'),

    createInvoice: create<QboInvoice>('invoice', 'Invoice'),
    updateInvoice: create<QboInvoice>('invoice', 'Invoice'),
    getInvoice: read<QboInvoice>('invoice', 'Invoice'),
    voidInvoice: voidDoc<QboInvoice>('invoice', 'Invoice'),

    createSalesReceipt: create<QboSalesReceipt>('salesreceipt', 'SalesReceipt'),
    updateSalesReceipt: create<QboSalesReceipt>('salesreceipt', 'SalesReceipt'),
    getSalesReceipt: read<QboSalesReceipt>('salesreceipt', 'SalesReceipt'),
    voidSalesReceipt: voidDoc<QboSalesReceipt>('salesreceipt', 'SalesReceipt'),

    createPayment: create<QboPayment>('payment', 'Payment'),
    updatePayment: create<QboPayment>('payment', 'Payment'),
    getPayment: read<QboPayment>('payment', 'Payment'),
    voidPayment: voidDoc<QboPayment>('payment', 'Payment'),

    createCreditMemo: create<QboCreditMemo>('creditmemo', 'CreditMemo'),
    updateCreditMemo: create<QboCreditMemo>('creditmemo', 'CreditMemo'),
    getCreditMemo: read<QboCreditMemo>('creditmemo', 'CreditMemo'),
    voidCreditMemo: voidDoc<QboCreditMemo>('creditmemo', 'CreditMemo'),

    createRefundReceipt: create<QboRefundReceipt>('refundreceipt', 'RefundReceipt'),
    getRefundReceipt: read<QboRefundReceipt>('refundreceipt', 'RefundReceipt'),

    createJournalEntry: create<QboJournalEntry>('journalentry', 'JournalEntry'),
    updateJournalEntry: create<QboJournalEntry>('journalentry', 'JournalEntry'),
    getJournalEntry: read<QboJournalEntry>('journalentry', 'JournalEntry'),
  }
}
