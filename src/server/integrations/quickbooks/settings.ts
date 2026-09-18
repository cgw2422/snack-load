import { z } from 'zod'

/**
 * What a distributor has to tell us about their chart of accounts (docs/08 §6).
 *
 * **Account IDs, never account names.** "Sales of Product Income" is a label a
 * bookkeeper can rename on a Tuesday; the id behind it does not move. Names are
 * kept alongside purely so the settings screen can say what was chosen without
 * a round trip, and are refreshed from QuickBooks rather than matched on.
 *
 * Nothing is auto-created. An integration that quietly invents a "SnackLoad
 * Sales" account has made a decision about somebody's books that they did not
 * make, and they will find it at year end (§6).
 */

const accountRef = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
})

export type AccountRef = z.infer<typeof accountRef>

export const quickBooksSettingsSchema = z.object({
  accounts: z
    .object({
      /** Where sales revenue lands. Required before any sale can sync. */
      salesIncome: accountRef.optional(),
      /** Returns and discounts, where the distributor keeps them separate. */
      returnsAndDiscounts: accountRef.optional(),
      /** Receivable for invoices. QuickBooks usually picks its own; this
       *  overrides it for a company with more than one A/R account. */
      accountsReceivable: accountRef.optional(),
      /** Where counter payments and sales receipts deposit. */
      undepositedFunds: accountRef.optional(),
      /** Debited by the periodic COGS journal. */
      costOfGoodsSold: accountRef.optional(),
      /** Credited by the same journal — the offset to COGS. */
      inventoryAsset: accountRef.optional(),
      /** Where tax is owed, for companies not on Automated Sales Tax. */
      salesTaxPayable: accountRef.optional(),
      /** Where a cash refund is paid from. */
      refundClearing: accountRef.optional(),
    })
    .default({}),

  tax: z
    .object({
      /**
       * Whether the company computes tax itself. Read from QuickBooks at
       * connect time, not guessed; it decides what a transaction must carry for
       * our historical figure to survive (§8).
       */
      automatedSalesTaxEnabled: z.boolean().default(false),
      /** The tax code sent with `TxnTaxDetail` to signal an explicit override. */
      taxCodeRef: z.object({ id: z.string(), name: z.string() }).optional(),
      /**
       * What to do with a document posted before the tax snapshot existed
       * (§9). `TOTALS_ONLY` sends the amounts we do hold and flags the
       * provenance; `REVIEW` refuses to sync it until a human decides.
       */
      legacyPolicy: z.enum(['TOTALS_ONLY', 'REVIEW']).default('TOTALS_ONLY'),
    })
    .default({ automatedSalesTaxEnabled: false, legacyPolicy: 'TOTALS_ONLY' }),

  documents: z
    .object({
      /**
       * Whether to send our document numbers as QuickBooks `DocNumber`.
       * Off by default: a company with its own invoice numbering gets a
       * duplicate-number rejection, which is a validation error per document
       * and a bad first day (§7).
       */
      sendDocumentNumbers: z.boolean().default(false),
      /** Put the SnackLoad number in `PrivateNote` regardless, for support. */
      referenceInPrivateNote: z.boolean().default(true),
    })
    .default({ sendDocumentNumbers: false, referenceInPrivateNote: true }),

  /** Paused by an operator without disconnecting. Jobs queue and wait. */
  syncPaused: z.boolean().default(false),
})

export type QuickBooksSettings = z.infer<typeof quickBooksSettingsSchema>

/** Defaults for a connection that has not been configured yet. */
export function readSettings(value: unknown): QuickBooksSettings {
  const parsed = quickBooksSettingsSchema.safeParse(value ?? {})
  // A settings blob written by an older build must not take the integration
  // down; the defaults are safe, and the screen shows what is still missing.
  return parsed.success ? parsed.data : quickBooksSettingsSchema.parse({})
}

export type MissingMapping = { key: string; label: string; why: string }

/**
 * What still has to be chosen before a given kind of document can sync.
 *
 * Returned rather than thrown, so the settings screen can show the whole list
 * at once instead of revealing one missing account per failed sync.
 */
export function missingMappings(
  settings: QuickBooksSettings,
  need: 'sales' | 'cogs',
): MissingMapping[] {
  const missing: MissingMapping[] = []
  const { accounts } = settings

  if (need === 'sales' && !accounts.salesIncome) {
    missing.push({
      key: 'accounts.salesIncome',
      label: 'Sales income account',
      why: 'Every product sold needs an income account for QuickBooks to post revenue to.',
    })
  }

  if (need === 'cogs') {
    if (!accounts.costOfGoodsSold) {
      missing.push({
        key: 'accounts.costOfGoodsSold',
        label: 'Cost of goods sold account',
        why: 'The periodic COGS journal debits this account.',
      })
    }
    if (!accounts.inventoryAsset) {
      missing.push({
        key: 'accounts.inventoryAsset',
        label: 'Inventory asset account',
        why: 'The COGS journal credits this account, so the entry balances.',
      })
    }
  }

  return missing
}
