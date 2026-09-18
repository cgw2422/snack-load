# QuickBooks Online — the integration as built

Phase 8. `docs/07` is the object mapping decided before any code existed; this
is what the code does, why, and what an operator or a support conversation needs
to know.

The governing idea, which every decision below follows from:

> **SnackLoad is the source of truth. QuickBooks is an accounting destination.**

Sales, stock, routes, returns, historical cost, receipts, customer balances and
operational reporting all live here and are never overwritten from over there.
An Intuit outage is not allowed to stop a runner completing a sale, taking a
payment, issuing a return or closing a route — and structurally it cannot,
because nothing in the selling path ever calls Intuit.

---

## 1. Shape

```
posting transaction              worker (separate, later)
┌────────────────────────┐      ┌──────────────────────────────┐
│ sale / payment /       │      │ claim job                    │
│ credit / refund / COGS │      │ resolve refs → build payload │
│        +               │ ───▶ │ push with requestid          │
│ SyncJob row            │      │ reconcile totals + tax       │
└────────────────────────┘      │ ExternalMapping + SyncLog    │
   one commit, or neither       └──────────────────────────────┘
```

| File | Holds |
|---|---|
| `integrations/quickbooks/types.ts` | The `QuickBooksClient` interface and the entity shapes. The rest of the app imports only from here. |
| `integrations/quickbooks/oauth.ts` | Authorize URL, code exchange, refresh, revoke. No database. |
| `integrations/quickbooks/client.ts` | The only file that talks to Intuit over HTTP. |
| `integrations/quickbooks/fake.ts` | A deterministic in-memory QuickBooks, for tests. |
| `integrations/quickbooks/documents.ts` | Posted SnackLoad documents → QuickBooks payloads. Pure. |
| `integrations/quickbooks/settings.ts` | Account mappings and tax policy, typed. |
| `integrations/quickbooks/mapping.ts` | `ExternalMapping` and the source hash. |
| `integrations/quickbooks/sync/*` | Queue, worker, syncers, reconciliation, posting hooks. |
| `services/integration.service.ts` | Connection lifecycle, settings, issues, history. |
| `services/cogs.service.ts` | COGS batches. |

Everything Intuit-specific is behind the adapter. The sync engine, the services
and the UI could be pointed at a different accounting system by writing one new
`client.ts`.

---

## 2. What was verified against Intuit, and when

Checked September 2026, because an integration written from an old SDK example
is an integration that breaks quietly:

| Thing | Current behaviour | Where it shows up |
|---|---|---|
| Minor version | **75**. Versions 1–74 deprecated August 2025; a lower value is treated as 75 anyway. | Sent explicitly on every call rather than left to a default that has moved before. |
| Authorization | `GET https://appcenter.intuit.com/connect/oauth2` | `oauth.ts` |
| Token / refresh | `POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`, HTTP Basic, form-encoded | `oauth.ts` |
| Revoke | `POST https://developer.api.intuit.com/v2/oauth2/tokens/revoke` | `disconnect` |
| Scope | `com.intuit.quickbooks.accounting` only | We never ask for payments or the identity scopes |
| Access token | one hour | refreshed with five minutes to spare |
| Refresh token | **rotates on every refresh**; outer lifetime now up to five years | §3 — the rotation is the hard part |
| Idempotency | a **`requestid`** query parameter makes a mutation replayable: the same id returns the original response instead of creating a second document | §5 — the whole duplicate story |
| Updates | require the current `SyncToken`; a stale one is rejected | §11 |
| Rate limits | 500 requests/minute per company, 10 concurrent; 429 carries `Retry-After` | `TRANSIENT`, honoured rather than guessed |
| Errors | a `Fault` envelope with `code`, `Message`, `Detail` | `classifyFault` |
| Tax override | `TxnTaxDetail.TotalTax` is honoured — including under Automated Sales Tax — but only when `TxnTaxCodeRef` is also sent | §8 |
| Webhooks | `intuit-signature`, HMAC-SHA256 base64 over the **raw** body | §12 |

Sandbox and production differ only in the API host; OAuth is the same for both.

---

## 3. OAuth and tokens

**States**, as the screen shows them: `NOT CONNECTED`, `CONNECTING`,
`CONNECTED`, `NEEDS REAUTH`, `ERROR`.

1. An operator chooses **sandbox or production**. That choice is written on the
   connection before the redirect and is never inferred from `NODE_ENV`. A
   staging deployment silently pointed at a production realm is the accident
   this prevents, and it is not the kind anyone notices quickly.
2. A 32-byte CSPRNG `state` is stored on the connection. The callback compares
   it in constant time and consumes it; it expires in ten minutes. That is what
   stops a forged callback attaching someone else's company to this tenant.
3. The callback (`/api/integrations/quickbooks/callback`) is a route handler,
   not a server action, because it is a top-level navigation from another
   origin. The code is exchanged server-side and never reaches the browser.
4. Tokens are sealed with **AES-256-GCM** as `v1:iv:tag:ciphertext`
   (`crypto/secretBox.ts`) under a key derived from `ENCRYPTION_KEY`. The
   version prefix makes rotation possible. Nothing returns a token to the UI —
   not even masked.

### Rotation, which is the difficult part

Intuit issues a **new refresh token on every refresh and invalidates the old
one**. Two consequences:

- the new token must be persisted on every single refresh, or the connection
  dies at the next one;
- two workers refreshing at the same moment would have one invalidate the
  other's token.

`accessTokenFor` therefore takes `SELECT … FOR UPDATE` on the connection row.
The second caller waits, re-reads, and finds a token that is already fresh —
the same discipline as the inventory ledger's balance rows, for the same reason
(`docs/02 §L3`).

If a refresh fails permanently (`invalid_grant`), the connection becomes
`NEEDS_REAUTH`. Selling carries on. **Mappings are not deleted**, so reconnecting
resumes rather than restarts.

---

## 4. The sync state machine

| State | Means | Who moves it |
|---|---|---|
| `PENDING` | queued | worker claims it |
| `IN_PROGRESS` | a worker holds it | claimed atomically with `FOR UPDATE SKIP LOCKED` |
| `SYNCED` | QuickBooks holds a document that reconciles to ours | — |
| `RETRYING` | transient: timeout, 429, 5xx | backoff, then automatic |
| `NEEDS_ATTENTION` | a person has to change something | the issues screen |
| `BLOCKED_DEPENDENCY` | waiting on another document | released when that one syncs |
| `FAILED` | nothing in this build knows how to sync it | — |

Jobs are enqueued **inside the transaction that posts the document**. A sale
that committed always has its job; a sale that rolled back never does. Nothing
in `enqueueIfConnected` can fail a checkout: it writes one row to our own
database and does not know Intuit exists.

`SyncJob` is the single reliability mechanism. `OutboxEvent` already existed for
general domain events and was deliberately left alone rather than grown a second
retry loop that would drift from this one.

`postInventoryTransaction` has no hook and never will: QuickBooks does not own
SnackLoad's stock, so truck loads, transfers and adjustments are not accounting
events here. Their cost effect arrives once a period, as a journal (§9).

### Dependency ordering

```
Customer ─┐
Product ──┴─▶ Sale (Invoice | SalesReceipt) ─┬─▶ Payment
                                             ├─▶ CreditMemo ─┬─▶ CreditMemoApplication
                                             │               └─▶ Refund
CogsJournalBatch (independent, once accounts are mapped)
```

A syncer that needs an unmapped reference raises `DependencyNotReady`. The
worker enqueues the dependency, parks this job against it, and **sends nothing
to Intuit**. When the dependency succeeds, `releaseDependents` puts everything
waiting on it back in the queue. An invoice whose customer has not mapped does
not spend the afternoon asking QuickBooks the same impossible question.

---

## 5. Duplicate prevention

Two independent mechanisms, because this is the failure that costs money.

**The request id.** Minted once when a job is created and reused on every
retry. Intuit replays the original response for a repeated `requestid` rather
than creating a second document. Minting one per attempt would mean a document
per attempt, which is exactly the bug.

The one exception: a **human-initiated re-sync** rotates the id, because it is a
new intent. Reusing the id that created the document would make Intuit replay
the create response and change nothing. Retries never rotate.

**The mapping row.** Opened *before* the push, with `externalId` null until
QuickBooks answers. A crash between sending and recording still leaves a trail.

And a third, cheaper guard: **`sourceHash`**. A re-queued push whose payload
hashes the same as the last successful one is a no-op — no call, no rate-limit
slot burned, no pointless bump of their `SyncToken`.

The proof is `tests/integration/quickbooks-duplicates.test.ts`, which runs the
lost-response scenario for Invoice, SalesReceipt, Payment, CreditMemo,
JournalEntry and Customer. The fake writes to its idempotency ledger *before*
throwing, which is the interleaving that makes this hard.

---

## 6. Account mapping

Nothing is hardcoded and nothing is auto-created. The chart of accounts is read
live from QuickBooks and the operator chooses; we store the **account ID**, with
the name alongside for display only. An integration that quietly invents a
"SnackLoad Sales" account has made a decision about someone's books that they
did not make, and they find it at year end.

| Mapping | Used for |
|---|---|
| Sales income | every item's `IncomeAccountRef`. Required before any sale syncs. |
| Returns and discounts | the discount line |
| Accounts receivable | only for a company with more than one A/R account |
| Undeposited funds | counter payments, sales receipts |
| Cost of goods sold | debited by the COGS journal |
| Inventory asset | credited by the same journal |
| Sales tax payable | companies not on Automated Sales Tax |
| Refund clearing | where a cash refund is paid from |

A missing mapping produces a `MAPPING` issue naming the setting to change, not
an Intuit error code. Saving the settings re-queues everything that was blocked
on one.

---

## 7. Entity mapping as implemented

| SnackLoad | QuickBooks | Notes |
|---|---|---|
| `Customer` | `Customer` | `DisplayName` is `Name (account number)` — QuickBooks requires uniqueness and two stores really are both called "Marathon". Identity is still the mapping row. |
| `Product` | `Item`, **NonInventory** | We never sync quantities. `docs/07 §3`. |
| `Sale` where `documentType = INVOICE` | `Invoice` | with `DueDate` |
| `Sale` where `documentType = SALES_RECEIPT` | `SalesReceipt` | deposits to undeposited funds |
| `SaleItem` | `SalesItemLineDetail` | quantity in the **unit that was sold**, unit named in the description |
| document discount | a `DiscountLineDetail` line | keeps `Qty × UnitPrice = Amount` true on every item line |
| `Payment` | `Payment`, one line per allocation, each `LinkedTxn` to its invoice | |
| `Payment` against a `SALES_RECEIPT` | **nothing** | the receipt already records the money; a second object would credit the customer twice |
| `CreditMemo` | `CreditMemo` | |
| `CreditMemoApplication` | a **zero-total `Payment`** linking the credit memo and the invoice | not a cash movement |
| `Refund` | `RefundReceipt`, plus a zero-total `Payment` linking it to the credit memo | so the credit stops showing as available |
| `Return` | **nothing** | its money is the credit memo. The return number rides in `PrivateNote`. |
| `CogsJournalBatch` | `JournalEntry` | one per period |
| `InventoryTransaction` | **nothing** | |

`Sale.documentType` is read, never re-derived. An invoice paid off next month is
still an invoice; a credited sales receipt is still a sales receipt.

### Refunds are three paths, not one

- credit **applied** to open invoices → the zero-total linking Payment. No cash
  object.
- credit **refunded** → a `RefundReceipt` for the money, then a zero-total
  Payment linking it to the credit memo.
- credit left **unapplied** → the credit memo alone is the whole representation.

The refund syncer makes two calls with **derived** request ids
(`<id>-receipt`, `<id>-link`), so a retry sends the same pair and lands on the
same pair of documents.

---

## 8. Reconciliation — the thing that makes this an accounting integration

After every push, before anything is marked synced:

- **Total.** SnackLoad's total must equal QuickBooks' `TotalAmt` **to the cent**.
- **Tax.** SnackLoad's tax must equal QuickBooks' `TxnTaxDetail.TotalTax`.

No tolerance. A tolerance is a decision to stop noticing, and the amount that
slips through it is never the last one. A mismatch becomes `AMOUNT_MISMATCH` or
`TAX_MISMATCH` on the issues screen; the mapping keeps the external id, because
the document does exist over there and re-sending it would be the duplicate we
spent the phase preventing.

`sync/reconcile.ts` is also the one place money legitimately becomes a
JavaScript number: Intuit's API is JSON and its amounts are numbers. The
conversion happens at the boundary, under the comparison that would catch it if
it ever lost a cent, rather than scattered through the payload builders where
nobody would (`docs/02 §M1`).

### Tax

Historical amounts are sent explicitly: `TxnTaxDetail.TotalTax` with
`TxnTaxCodeRef` to mark it an intentional override. Without the code ref an
Automated Sales Tax company silently substitutes its own figure.

Every figure comes off the document's own snapshot — per line `taxable`,
`taxableAmount`, `taxRateApplied`, `taxAmount`; per header `taxJson` with the
rate's identity, code, jurisdiction, the exemption and the certificate behind it.
Nothing reads the customer's current tax settings (`docs/02 §M4`).

AST is detected at connect time and shown on the settings screen. It does not
change whether we sync, only what we send — and if QuickBooks still recomputes,
the document is raised as an issue rather than accepted.

---

## 9. Legacy tax rows — the policy

Some documents were posted before SnackLoad captured tax provenance. They carry
a real total and a real tax amount and nothing that explains them.

**The policy, settable per organization, defaulting to `TOTALS_ONLY`:**

- **`TOTALS_ONLY`** — send the amounts as posted, and write
  *"Tax detail not recorded (posted before SnackLoad captured tax provenance)"*
  into the document's `PrivateNote`. The sync log says the same. Nothing is
  invented: no rate, no jurisdiction, no exemption status.
- **`REVIEW`** — hold those documents as issues instead, for a bookkeeper to
  decide one at a time.

A rate is never back-derived from the amounts, and the customer's current
settings are never consulted to fill the gap. A plausible-looking fabricated
jurisdiction is worse than an honest blank, because somebody will file on it.

The demo data is fully snapshotted, so this policy exists for real history, not
for seed data.

---

## 10. COGS journals

QuickBooks does not own SnackLoad's stock, so cost reaches it once a period:

```
  COGS of sales posted in the period      (unit_cost_at_sale, frozen at the sale)
− COGS reversed by credits in the period  (the cost that came back)
= the journal amount                       debit COGS, credit inventory asset
```

Both halves read `unit_cost_at_sale`, never a current cost. That is what makes
the batch tie **exactly** to the gross-profit report for the same window — the
two run the same arithmetic over the same columns, and a test asserts they agree
rather than trusting it.

`CogsJournalBatch` is a **row**, because a journal entry needs something to be a
retry *of*. "The September journal" is not an identity: run the date arithmetic
twice and QuickBooks has two entries and a doubled cost. A batch is unique per
`(organization, periodStart, periodEnd)`, computed as a `DRAFT`, frozen on
`POSTED`, and voided rather than edited. `sourceHash` means a recomputation that
disagrees is visible — posted history should not move.

---

## 11. Direction of ownership

One way: **SnackLoad → QuickBooks.** Nothing is imported back.

- A **stale `SyncToken`** means somebody edited their copy. That becomes an
  `EXTERNAL_CONFLICT` issue. SnackLoad does not overwrite it; a person
  reconciles the two and then chooses.
- A **re-sync** updates the mapped document in place using its `SyncToken`. It
  cannot create a duplicate, and it cannot change SnackLoad's figures —
  everything it sends comes off the posted document.
- **Disconnect** removes credentials and stops syncing. It does **not** delete
  `ExternalMapping` rows, `SyncLog` rows or anything else. Reconnecting to the
  same company resumes.
- Reconnecting to a **different realm** marks the old mappings
  `NEEDS_ATTENTION` with the previous realm id in the message. They point into
  books that are not these books, so they are kept but never reused.

---

## 12. Webhooks

`/api/webhooks/quickbooks` verifies `intuit-signature` — HMAC-SHA256 over the
**raw body text** under the verifier token — before reading anything. Without a
configured verifier every request is refused rather than trusted. (Hashing a
re-stringified payload is the usual reason a correct implementation fails:
`JSON.stringify` drops whitespace and changes the digest.)

A delivery **flags**, it does not act. An entity edited or deleted in QuickBooks
marks its mapping `NEEDS_ATTENTION` with a message saying SnackLoad has not
changed anything. A notification is not evidence about our documents.

---

## 13. Errors and retries

| Category | Example | Behaviour |
|---|---|---|
| `TRANSIENT` | timeout, 429, 5xx | exponential backoff with jitter from 30s, capped at 1 hour, `Retry-After` honoured, 8 attempts then `NEEDS_ATTENTION` |
| `VALIDATION` | Intuit rejected the document | no retry; the message is Intuit's own |
| `MAPPING` | an account or reference is gone | no retry; re-queued when settings are saved |
| `AUTHORIZATION` | revoked or expired grant | stops the whole pass, connection → `NEEDS_REAUTH` |
| `TAX_MISMATCH` / `AMOUNT_MISMATCH` | their figure ≠ ours | no retry; a human decides |
| `EXTERNAL_CONFLICT` | stale `SyncToken` | no retry; surfaced |
| `DEPENDENCY` | waiting on another document | released automatically |

The jitter cap is applied **after** the jitter, not before — otherwise a 1.25×
jitter on an already-capped hour produces 75 minutes.

---

## 14. Sync issues and history

Every issue shows the SnackLoad document number and store — not a row id — the
time, Intuit's own error text, whether it is retryable, one sentence of
corrective advice, and the action that would actually fix it: `RETRY`,
`REMAP CUSTOMER`, `REMAP ITEM`, `CHANGE ACCOUNTS`, `RECONNECT`, or
`OPEN IN SNACKLOAD`. Nobody should have to read a server log to understand a
routine integration failure.

`SyncLog` keeps the decision and Intuit's error text. It deliberately does **not**
keep request or response bodies: those carry customer addresses and, on an auth
path, tokens (`docs/04 §7`).

---

## 15. Testing

`fake.ts` is a real implementation of the interface with an in-memory company
behind it and a fault switch on the front: `transient`, `lose-response`,
`rate-limit`, `auth-revoked`, `validation`, `mapping`, `stale-token`,
`recompute-tax`, `shift-total`. The suite drives the real worker, the real
syncers and the real payload builders; only the transport is substituted.

| Suite | Covers |
|---|---|
| `quickbooks-duplicates.test.ts` | the lost-response scenario for every document type |
| `quickbooks-scenarios.test.ts` | scenarios A–H and the COGS-to-report tie |
| `quickbooks-adapter.test.ts` | error classification, backoff, dependencies, reconciliation refusals, issues, re-sync, legacy tax, secrets, environments |

An explicit sandbox suite would run against a real Intuit company where
credentials exist. It does not gate the build: a suite that waits for Intuit to
have a good day is a suite nobody runs.

---

## 16. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Everything says "Waiting" | the customer or an item has not mapped | look for the `Customer`/`Product` issue underneath; it is the real one |
| "Choose the sales income account…" | no income account mapped | Account mapping, then save — blocked work re-queues itself |
| `TAX_MISMATCH` on every document | Automated Sales Tax without a tax code mapped | set the tax code, or review the company's AST settings |
| One document off by a cent | QuickBooks restated it | compare the two; the sync is deliberately refused until someone decides |
| `NEEDS_REAUTH` after a quiet weekend | refresh token rotated out or was revoked | Reconnect. Mappings survive. |
| Same invoice twice in QuickBooks | should be impossible via this path | check whether it was also entered by hand; the mapping shows which one is ours |
| Nothing queues at all | not connected, or sync paused | the connection card says which |

---

## 17. What Phase 8 deliberately does not do

- No write-back from QuickBooks.
- No inventory quantities, ever.
- No account creation on the customer's behalf.
- No document-number collision handling beyond the setting: a company that
  numbers its own invoices should leave `sendDocumentNumbers` off.
- No multi-currency. Everything assumes the organization's own currency.
- No `Return` object, because there should not be one.
