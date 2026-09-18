import {
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
 * A deterministic QuickBooks, for tests (docs/08 §11).
 *
 * The suite must not depend on Intuit being up, and the failures that matter
 * most — a response lost after the document was created, a revoked grant, a
 * stale SyncToken — are ones a sandbox will not produce on demand. So this is a
 * real implementation of the interface with an in-memory company behind it, and
 * a fault switch on the front.
 *
 * The one behaviour it models exactly, because everything rests on it: a
 * repeated **`requestId` replays the original response**. `requests` is the
 * fake's copy of Intuit's idempotency ledger, and `lose-response` writes to it
 * *before* throwing — which is precisely the interleaving that would otherwise
 * produce two invoices for one sale.
 */

export type FaultMode =
  /** Fails with a transient error, having done nothing. */
  | { kind: 'transient'; message?: string }
  /**
   * The document IS created and the request id IS recorded — and then the
   * response is lost. The dangerous one.
   */
  | { kind: 'lose-response' }
  | { kind: 'rate-limit'; retryAfterSeconds?: number }
  | { kind: 'auth-revoked' }
  | { kind: 'validation'; message?: string; code?: string }
  | { kind: 'mapping'; message?: string }
  | { kind: 'stale-token' }
  /** QuickBooks records a tax figure of its own, ignoring what we sent. */
  | { kind: 'recompute-tax'; totalTax: number }
  /** QuickBooks lands on a different total. */
  | { kind: 'shift-total'; by: number }

type Entity = { Id?: string; SyncToken?: string; [key: string]: unknown }

export type FakeQuickBooks = QuickBooksClient & {
  /** Everything the company holds, by entity name. */
  readonly store: Map<string, Map<string, Entity>>
  /** Intuit's idempotency ledger: request id → the response it first produced. */
  readonly requests: Map<string, unknown>
  /** Every call made, for asserting what the worker actually did. */
  readonly calls: { method: string; requestId?: string }[]

  /** Applies a fault to the next matching call only. */
  failNext(method: string, mode: FaultMode): void
  /** Applies a fault to every call until cleared. */
  failAlways(method: string, mode: FaultMode): void
  clearFaults(): void

  countOf(entity: string): number
  allOf<T>(entity: string): T[]
}

export function createFakeQuickBooks(
  options: { realmId?: string; environment?: QuickBooksEnvironment; automatedSalesTax?: boolean } = {},
): FakeQuickBooks {
  const store = new Map<string, Map<string, Entity>>()
  const requests = new Map<string, unknown>()
  const calls: { method: string; requestId?: string }[] = []
  const once = new Map<string, FaultMode>()
  const always = new Map<string, FaultMode>()
  let sequence = 1000

  const table = (entity: string) => {
    let rows = store.get(entity)
    if (!rows) {
      rows = new Map()
      store.set(entity, rows)
    }
    return rows
  }

  function takeFault(method: string): FaultMode | undefined {
    const single = once.get(method)
    if (single) {
      once.delete(method)
      return single
    }
    return always.get(method)
  }

  function throwFor(mode: FaultMode): never {
    switch (mode.kind) {
      case 'transient':
        return raise(new QuickBooksError('TRANSIENT', mode.message ?? 'Could not reach QuickBooks.'))
      case 'lose-response':
        return raise(
          new QuickBooksError('TRANSIENT', 'Could not reach QuickBooks.', {
            detail: 'socket hang up',
          }),
        )
      case 'rate-limit':
        return raise(
          new QuickBooksError('TRANSIENT', 'QuickBooks is rate limiting this company.', {
            httpStatus: 429,
            retryAfterSeconds: mode.retryAfterSeconds ?? 30,
          }),
        )
      case 'auth-revoked':
        return raise(
          new QuickBooksError(
            'AUTHORIZATION',
            'QuickBooks refused the connection. It may have been disconnected in QuickBooks.',
            { httpStatus: 401 },
          ),
        )
      case 'validation':
        return raise(
          new QuickBooksError('VALIDATION', mode.message ?? 'QuickBooks rejected the document.', {
            code: mode.code ?? '6000',
            httpStatus: 400,
          }),
        )
      case 'mapping':
        return raise(
          new QuickBooksError('MAPPING', mode.message ?? 'That account no longer exists.', {
            code: '610',
            httpStatus: 400,
          }),
        )
      case 'stale-token':
        return raise(
          new QuickBooksError(
            'EXTERNAL_CONFLICT',
            'The QuickBooks copy of this document was changed since SnackLoad last read it.',
            { code: '5010', httpStatus: 400 },
          ),
        )
      default:
        return raise(new QuickBooksError('TRANSIENT', 'Unexpected fake fault.'))
    }
  }

  const raise = (error: QuickBooksError): never => {
    throw error
  }

  /**
   * Line total before tax, the way QuickBooks computes it.
   *
   * Item lines add and a discount line subtracts. A journal entry is different
   * again: its total is ONE side of the entry, so the debits are summed and the
   * credits ignored — summing both would report double the amount posted.
   *
   * Modelled rather than assumed, because a fake that gets this wrong lets a
   * broken payload pass a green test, and the reconciliation check that caught
   * it here is the one thing standing between a cent of drift and a year end.
   */
  function netOf(entity: Entity): number {
    const lines = (entity.Line ?? []) as {
      Amount?: number
      DetailType?: string
      JournalEntryLineDetail?: { PostingType?: string }
    }[]

    if (lines.some((line) => line.DetailType === 'JournalEntryLineDetail')) {
      return lines
        .filter((line) => line.JournalEntryLineDetail?.PostingType === 'Debit')
        .reduce((total, line) => total + (line.Amount ?? 0), 0)
    }

    return lines.reduce(
      (total, line) =>
        line.DetailType === 'DiscountLineDetail'
          ? total - (line.Amount ?? 0)
          : total + (line.Amount ?? 0),
      0,
    )
  }

  /**
   * One write path, so every entity behaves the same way about ids, sync tokens
   * and — above all — replayed request ids.
   */
  function write<T extends Entity>(entity: string, method: string, input: T, requestId: string): T {
    calls.push({ method, requestId })

    const replay = requests.get(requestId)
    if (replay !== undefined) return replay as T

    const fault = takeFault(method)
    if (fault && fault.kind !== 'lose-response' && fault.kind !== 'recompute-tax' && fault.kind !== 'shift-total') {
      throwFor(fault)
    }

    const rows = table(entity)
    const existing = input.Id ? rows.get(input.Id) : undefined

    if (input.Id && !existing) {
      throw new QuickBooksError('VALIDATION', 'That object does not exist in QuickBooks.', {
        code: '610',
        httpStatus: 404,
      })
    }

    const stored: Entity = {
      ...input,
      Id: input.Id ?? String(++sequence),
      SyncToken: existing ? String(Number(existing.SyncToken ?? '0') + 1) : '0',
    }

    if (fault?.kind === 'recompute-tax') {
      const detail = (stored.TxnTaxDetail ?? {}) as Record<string, unknown>
      stored.TxnTaxDetail = { ...detail, TotalTax: fault.totalTax }
      stored.TotalAmt = Number((netOf(stored) + fault.totalTax).toFixed(2))
    } else if (typeof stored.TotalAmt !== 'number') {
      const tax = Number((stored.TxnTaxDetail as { TotalTax?: number } | undefined)?.TotalTax ?? 0)
      stored.TotalAmt = Number((netOf(stored) + tax).toFixed(2))
    }

    if (fault?.kind === 'shift-total') {
      stored.TotalAmt = Number((Number(stored.TotalAmt ?? 0) + fault.by).toFixed(2))
    }

    rows.set(stored.Id!, stored)
    // Recorded BEFORE the response can be lost, exactly as Intuit records it.
    requests.set(requestId, stored)

    if (fault?.kind === 'lose-response') throwFor(fault)

    return stored as T
  }

  function readOne<T>(entity: string, method: string, id: string): T | null {
    calls.push({ method })
    const fault = takeFault(method)
    if (fault) throwFor(fault)
    return (table(entity).get(id) as T) ?? null
  }

  function voidOne<T>(entity: string, method: string, id: string, syncToken: string, requestId: string): T {
    calls.push({ method, requestId })
    const replay = requests.get(requestId)
    if (replay !== undefined) return replay as T

    const fault = takeFault(method)
    if (fault && fault.kind !== 'lose-response') throwFor(fault)

    const row = table(entity).get(id)
    if (!row) {
      throw new QuickBooksError('VALIDATION', 'That object does not exist in QuickBooks.', { code: '610' })
    }
    if (String(row.SyncToken) !== String(syncToken)) {
      throw new QuickBooksError(
        'EXTERNAL_CONFLICT',
        'The QuickBooks copy of this document was changed since SnackLoad last read it.',
        { code: '5010' },
      )
    }

    // QuickBooks keeps a voided document and zeroes it. It never deletes.
    const voided: Entity = {
      ...row,
      void: true,
      TotalAmt: 0,
      Balance: 0,
      SyncToken: String(Number(row.SyncToken ?? '0') + 1),
      PrivateNote: `${(row.PrivateNote as string) ?? ''} VOIDED`.trim(),
    }
    table(entity).set(id, voided)
    requests.set(requestId, voided)

    if (fault?.kind === 'lose-response') throwFor(fault)
    return voided as T
  }

  const accounts: QboAccount[] = [
    { Id: '1', Name: 'Sales of Product Income', AccountType: 'Income', Classification: 'Revenue', Active: true },
    { Id: '2', Name: 'Discounts given', AccountType: 'Income', Classification: 'Revenue', Active: true },
    { Id: '3', Name: 'Accounts Receivable (A/R)', AccountType: 'Accounts Receivable', Active: true },
    { Id: '4', Name: 'Undeposited Funds', AccountType: 'Other Current Asset', Active: true },
    { Id: '5', Name: 'Cost of Goods Sold', AccountType: 'Cost of Goods Sold', Active: true },
    { Id: '6', Name: 'Inventory Asset', AccountType: 'Other Current Asset', Active: true },
    { Id: '7', Name: 'California Department of Tax and Fee Administration Payable', AccountType: 'Other Current Liability', Active: true },
    { Id: '8', Name: 'Checking', AccountType: 'Bank', Active: true },
  ]

  return {
    realmId: options.realmId ?? '4620816365320400000',
    environment: options.environment ?? 'SANDBOX',
    store,
    requests,
    calls,

    failNext: (method, mode) => once.set(method, mode),
    failAlways: (method, mode) => always.set(method, mode),
    clearFaults: () => {
      once.clear()
      always.clear()
    },
    countOf: (entity) => table(entity).size,
    allOf: <T>(entity: string) => [...table(entity).values()] as T[],

    async getCompanyInfo(): Promise<QboCompanyInfo> {
      calls.push({ method: 'getCompanyInfo' })
      const fault = takeFault('getCompanyInfo')
      if (fault) throwFor(fault)
      return { CompanyName: 'Sandbox Company_US_1', LegalName: 'Sandbox Company_US_1', Country: 'US' }
    },

    async listAccounts() {
      calls.push({ method: 'listAccounts' })
      const fault = takeFault('listAccounts')
      if (fault) throwFor(fault)
      return accounts
    },

    async getTaxService(): Promise<QboTaxService> {
      calls.push({ method: 'getTaxService' })
      const fault = takeFault('getTaxService')
      if (fault) throwFor(fault)
      return {
        automatedSalesTaxEnabled: options.automatedSalesTax ?? false,
        defaultTaxCodeRef: options.automatedSalesTax ? { value: 'TAX' } : null,
        taxRates: [{ id: '10', name: 'Ohio', rate: 7.25 }],
      }
    },

    async findCustomerByDisplayName(displayName) {
      calls.push({ method: 'findCustomerByDisplayName' })
      const fault = takeFault('findCustomerByDisplayName')
      if (fault) throwFor(fault)
      return (
        (table('Customer').values().toArray() as QboCustomer[]).find(
          (row) => row.DisplayName === displayName,
        ) ?? null
      )
    },
    createCustomer: async (input, requestId) => write<QboCustomer>('Customer', 'createCustomer', input, requestId),
    updateCustomer: async (input, requestId) => write<QboCustomer>('Customer', 'updateCustomer', input, requestId),
    getCustomer: async (id) => readOne<QboCustomer>('Customer', 'getCustomer', id),

    async findItemByName(name) {
      calls.push({ method: 'findItemByName' })
      const fault = takeFault('findItemByName')
      if (fault) throwFor(fault)
      return (table('Item').values().toArray() as QboItem[]).find((row) => row.Name === name) ?? null
    },
    createItem: async (input, requestId) => write<QboItem>('Item', 'createItem', input, requestId),
    updateItem: async (input, requestId) => write<QboItem>('Item', 'updateItem', input, requestId),
    getItem: async (id) => readOne<QboItem>('Item', 'getItem', id),

    createInvoice: async (input, requestId) => write<QboInvoice>('Invoice', 'createInvoice', input, requestId),
    updateInvoice: async (input, requestId) => write<QboInvoice>('Invoice', 'updateInvoice', input, requestId),
    getInvoice: async (id) => readOne<QboInvoice>('Invoice', 'getInvoice', id),
    voidInvoice: async (id, syncToken, requestId) =>
      voidOne<QboInvoice>('Invoice', 'voidInvoice', id, syncToken, requestId),

    createSalesReceipt: async (input, requestId) =>
      write<QboSalesReceipt>('SalesReceipt', 'createSalesReceipt', input, requestId),
    updateSalesReceipt: async (input, requestId) =>
      write<QboSalesReceipt>('SalesReceipt', 'updateSalesReceipt', input, requestId),
    getSalesReceipt: async (id) => readOne<QboSalesReceipt>('SalesReceipt', 'getSalesReceipt', id),
    voidSalesReceipt: async (id, syncToken, requestId) =>
      voidOne<QboSalesReceipt>('SalesReceipt', 'voidSalesReceipt', id, syncToken, requestId),

    createPayment: async (input, requestId) => write<QboPayment>('Payment', 'createPayment', input, requestId),
    updatePayment: async (input, requestId) => write<QboPayment>('Payment', 'updatePayment', input, requestId),
    getPayment: async (id) => readOne<QboPayment>('Payment', 'getPayment', id),
    voidPayment: async (id, syncToken, requestId) =>
      voidOne<QboPayment>('Payment', 'voidPayment', id, syncToken, requestId),

    createCreditMemo: async (input, requestId) =>
      write<QboCreditMemo>('CreditMemo', 'createCreditMemo', input, requestId),
    updateCreditMemo: async (input, requestId) =>
      write<QboCreditMemo>('CreditMemo', 'updateCreditMemo', input, requestId),
    getCreditMemo: async (id) => readOne<QboCreditMemo>('CreditMemo', 'getCreditMemo', id),
    voidCreditMemo: async (id, syncToken, requestId) =>
      voidOne<QboCreditMemo>('CreditMemo', 'voidCreditMemo', id, syncToken, requestId),

    createRefundReceipt: async (input, requestId) =>
      write<QboRefundReceipt>('RefundReceipt', 'createRefundReceipt', input, requestId),
    getRefundReceipt: async (id) => readOne<QboRefundReceipt>('RefundReceipt', 'getRefundReceipt', id),

    createJournalEntry: async (input, requestId) =>
      write<QboJournalEntry>('JournalEntry', 'createJournalEntry', input, requestId),
    updateJournalEntry: async (input, requestId) =>
      write<QboJournalEntry>('JournalEntry', 'updateJournalEntry', input, requestId),
    getJournalEntry: async (id) => readOne<QboJournalEntry>('JournalEntry', 'getJournalEntry', id),
  }
}
