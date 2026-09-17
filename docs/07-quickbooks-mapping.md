# QuickBooks Object Mapping — the contract Phase 8 implements

Written at the end of Phase 7.5 and revised after the financial-integrity
hardening pass, before any integration code exists, because the point of
finishing returns and credits first was to have a complete financial document
model to map *from*. Nothing here is implemented yet; §1a and §2 describe schema
that now exists, and everything else remains a contract for Phase 8.

SnackLoad's side of every row below is a document that already exists, has an
immutable number, and never changes after posting. That is what makes the sync
tractable: a mapping is `(our document, their id)`, and a document we have
already sent never needs to be sent differently.

---

## 1. The mapping table

| SnackLoad | QuickBooks Online | Notes |
|---|---|---|
| `Organization` | the connected company (realm) | One realm per organization. The realm id is part of the connection, never part of a document. |
| `Customer` | **Customer** | Matched on `accountNumber` first, then name. `parentCompany` maps to a QuickBooks sub-customer parent where the distributor uses one. |
| `Product` | **Item** (Inventory or Non-inventory) | See §3 — we do **not** let QuickBooks own stock. |
| `ProductUom` | — | No QuickBooks equivalent. Every quantity is converted to base units before it crosses. |
| `Sale` (COMPLETED, `balanceDue > 0`) | **Invoice** | Terms from `paymentTermsCode`, due date from `dueDate`. |
| `Sale` (COMPLETED, `balanceDue = 0` at post time) | **SalesReceipt** | Paid at the counter; no AR leg. See §2. |
| `Sale` (VOIDED) | **Invoice**, voided | Never deleted. |
| `SaleItem` | Invoice/SalesReceipt **Line** | Quantity in base units, `unitPrice`, `discountAmount`, taxable flag from the snapshot. |
| `Payment` | **Payment** | Linked to the invoices its allocations name. |
| `PaymentAllocation` | Payment **Line.LinkedTxn** | One per allocation. |
| `Payment.unappliedAmount` | Payment with no `LinkedTxn` | QuickBooks calls this an unapplied payment; the credit sits on the customer. |
| `Payment` (REVERSED) | Payment, voided | Not deleted. |
| `CreditMemo` | **CreditMemo** | Our number goes in `DocNumber`. |
| `CreditMemoItem` | CreditMemo **Line** | Historical price and tax from the snapshot, never today's item price. |
| `CreditMemoApplication` | CreditMemo **LinkedTxn** to the invoice | Or a `Payment` with a credit line, depending on the flow chosen in §4. |
| `Refund` | **RefundReceipt** | See §4 — the right object depends on what is being refunded. |
| `Return` | — | **No direct equivalent, and that is correct.** See §5. |
| `InventoryTransaction` | — | Not synced. See §3. |

---

## 1a. Identity: what a mapping is keyed on

A mapping row is `(organization, our entity type, our id) ↔ (their id)`. Our side
of it is always the **primary key** of the row, a cuid assigned at creation and
never reissued.

**Never a display name, and never a number a human can change.** A store renamed
from "Joe's Marathon" to "Joe's Corner Store" is the same customer; a mapping
keyed on the name would either create a second QuickBooks customer or, worse,
retarget the old one's invoices. The same argument rules out `Customer.accountNumber`
(editable), `Product.sku` (editable, and re-used when a product is replaced) and
the document numbers (immutable in practice, but they are *our* sequence, and an
organization that migrates its numbering would silently re-point every mapping).

| Entity | Local identity (the mapping key) | Human handle, for display and reconciliation only |
|---|---|---|
| Customer | `Customer.id` | `accountNumber`, `name` |
| Product | `Product.id` | `sku`, `name` |
| Sale → Invoice | `Sale.id`, where `Sale.documentType = INVOICE` | `saleNumber` |
| Sale → SalesReceipt | `Sale.id`, where `Sale.documentType = SALES_RECEIPT` | `saleNumber` |
| Payment | `Payment.id` | the sale numbers its allocations name |
| CreditMemo | `CreditMemo.id` | `number` |
| Refund | `Refund.id` | `refundNumber` |
| Periodic COGS journal | `(period start, period end)` for the organization, as a `CogsJournalBatch` row Phase 8 creates | the period, e.g. "2026-09" |

Two rows in that table share a local entity type (`Sale`), and that is deliberate:
`entityType` says which of *our* models the id belongs to, not which QuickBooks
object it becomes. Which object it becomes is `Sale.documentType`, decided once
and stored (§2). Keying the mapping on the QuickBooks object instead would let a
sale acquire two mappings if the split were ever recomputed.

The COGS journal is the one entity with no local document today. Phase 8 must
create one — a row per organization per period, with the totals it posted and
its own id — rather than mapping "the September journal" by date arithmetic. A
batch that cannot be identified cannot be retried safely, and retrying a journal
entry is how a P&L gets double-counted.

### What `ExternalMapping` carries

The Phase 1 scaffolding has been extended to hold everything a real sync needs:

| Column | What it is for |
|---|---|
| `organizationId` | The tenant. One realm per organization (§1). |
| `provider` | Which system. QuickBooks today; the shape is not specific to it. |
| `entityType`, `localId` | Our side of the identity, per the table above. |
| `externalId` | Their id. **Null until the first successful push**, so the row can be created when we decide to send and a crash between sending and recording still leaves a trail. |
| `externalSyncToken` | QuickBooks' own optimistic-concurrency token for their copy. |
| `status` | `PENDING`, `IN_PROGRESS`, `SYNCED`, `FAILED`, `RETRYING`, `NEEDS_ATTENTION`. |
| `sourceHash` | A hash of the fields we send. An equal hash means their copy is already the document we hold, so a re-queued push is a no-op. |
| `lastAttemptedAt` | When we last tried. |
| `lastSucceededAt` | When their copy was last correct. Separate from the above on purpose: the gap between the two is what a support call is about. |
| `lastError` | Intuit's own error text, verbatim. |
| `attempts` | How many tries this mapping has taken. |
| `createdAt`, `updatedAt` | Row lifecycle. |

---

## 2. Invoice versus Sales Receipt

The split is decided **once, at post time, and recorded** — not recomputed later,
because a sale that was paid in full at the counter and is later credited must
not retroactively become an invoice in QuickBooks, and an invoice that the store
pays off next month must not become a sales receipt.

- `amountPaid >= total` when the sale posted → **SalesReceipt**.
- Otherwise → **Invoice**, and the payment (if any) is a separate **Payment**
  object linked to it.

This now lives in `Sale.documentType`, a non-nullable enum column written by
`checkout` and by nothing else. It is on the sale, not on the outbox event, and
not on the mapping row:

- **Not the outbox event.** Outbox rows are processed and pruned. A re-sync a
  year later, a mapping rebuilt after a disconnection, or a support query about
  a 2026 document all need the answer long after the event is gone.
- **Not the mapping row.** What kind of document a sale *is* is a fact about the
  sale, true whether or not the distributor ever connects QuickBooks. Putting it
  on the integration's table would mean a sale has no answer until it is synced,
  and a different answer per provider.
- **Not derived on read.** `balanceDue = 0` is true of a paid invoice and of a
  sales receipt alike; deriving from it is precisely the bug.

Because the column is `NOT NULL` with no default, every code path that creates a
sale has to state which it is. Existing rows were backfilled once, in the
migration, from `balanceDue`/`amountPaid` — the only time that derivation is ever
performed.

---

## 3. Inventory: SnackLoad owns it

**Recommendation: map products as QuickBooks *Non-inventory* items, and do not
sync stock movements at all.**

QuickBooks Online's inventory uses FIFO and its own quantity-on-hand. SnackLoad
uses a moving average per location and holds stock across a warehouse and
several trucks, which QuickBooks cannot represent. Syncing both would produce two
sets of stock figures that disagree within a week, and the ledger's guarantee
(`SUM(ledger) == balance`, asserted by `findBalanceDrift`) would be meaningless
to anyone reading QuickBooks.

COGS reaches QuickBooks as a **periodic journal entry** from our own figures —
one entry per period, debiting COGS and crediting Inventory Asset by the total
`unitCostAtSale × baseQuantity` of sales less returns — rather than per line.
That keeps the P&L right without pretending QuickBooks knows where the cases are.

If a distributor insists on QuickBooks-side inventory, that is a per-organization
setting and a different (worse) mapping, and it should be written down as such.

---

## 4. Refunds: three flows, not one

The spec is right that the correct QuickBooks object depends on the original
transaction. `Refund.creditMemoId` always tells us which credit is being paid
out; what it was credited *against* decides the flow:

| Situation | QuickBooks |
|---|---|
| Credit memo applied to open invoices | **CreditMemo** + `LinkedTxn` to each invoice. No cash object. |
| Credit memo refunded, and the original sale was a **SalesReceipt** | **RefundReceipt** referencing the same items. |
| Credit memo refunded, and the original sale was an **Invoice** already paid | **CreditMemo**, then a **RefundReceipt** or a cheque **Purchase** against the customer, depending on tender. |
| Credit memo left unapplied | **CreditMemo** only. QuickBooks shows it as available credit, which matches our `remainingAmount`. |

`Refund.method` maps to the QuickBooks payment method; `referenceNumber` to
`PaymentRefNum` (cheque number, card authorisation, ACH trace).

---

## 5. Returns do not map, and should not

A `Return` is a **goods** document. Its money lives on the `CreditMemo` it
produced, and that is what QuickBooks needs. Inventing a QuickBooks object for
the return itself would either double-count the credit or create a stock movement
QuickBooks should not own (§3).

The return still matters to the integration in one way: the credit memo's
`DocNumber` should reference the return number in its `PrivateNote`, so somebody
reconciling in QuickBooks can find the goods document in SnackLoad.

---

## 6. Tax

QuickBooks recomputes tax from its own tax codes unless told otherwise. That
directly conflicts with `R4` — our credits reverse the tax that was *actually
charged*, prorated.

**Recommendation:** send invoices and credit memos with explicit line-level tax
amounts and `TxnTaxDetail` overrides, so QuickBooks records our figure rather
than deriving its own. Where the QuickBooks company has Automated Sales Tax
enabled (which forbids overrides), Phase 8 should detect it at connect time and
warn the distributor that totals may differ by rounding, rather than silently
letting the two disagree.

### What the posted document carries

That recommendation only works if every figure comes off the document. It now
does. Nothing below is read from the customer's current settings:

| Fact | Where it lives |
|---|---|
| Taxable basis | `SaleItem.taxableAmount`, `CreditMemoItem.taxableAmount` |
| Tax amount | `SaleItem.taxAmount`, `CreditMemoItem.taxAmount` |
| Rate applied | `SaleItem.taxRateApplied`, `CreditMemoItem.taxRateApplied` |
| Whether the line was taxable | `SaleItem.taxable`, `CreditMemoItem.taxable` |
| Tax code | `Sale.taxJson.code`, `CreditMemo.taxJson.code` (from `TaxRate.code`) |
| Jurisdiction | `Sale.taxJson.jurisdiction`, `CreditMemo.taxJson.jurisdiction` |
| Rate identity and name | `Sale.taxJson.rateId` / `.name` |
| Exemption state | `Sale.taxExempt` and `Sale.taxJson.exempt` |
| The certificate behind it | `Sale.taxJson.exemptId` |
| Reversed tax on a return | `CreditMemoItem.taxAmount`, prorated from the sale line |

Three of these were added in the hardening pass and are worth saying why:

- **`taxable` per line.** Tax of zero and "not taxable" are different facts. A
  bottle of water is never taxed; a case of Takis sold to an exempt store is
  taxable goods that were not taxed. QuickBooks needs to know which, and before
  this the only way to guess was `taxAmount > 0`, which answers both the same.
- **`taxableAmount` per line.** Carried even when the rate is zero, so an
  exemption report has the basis that was exempted. Reconstructing it from
  `lineSubtotal - discountAmount` requires knowing the line was taxable, which
  is the field above, and it silently mis-states any line carrying a share of a
  document discount.
- **`taxJson` on the header.** The regime, not just the number. A store that
  registers for an exemption in March must not change what February's invoice
  says it was charged, and a rate edited from 7.25% to 7.5% must not restate a
  closed quarter. `readTaxSnapshot` returns null for documents posted before
  this existed; callers must handle that rather than invent a regime.

A credit memo raised by a return copies the sale's `taxJson` verbatim. An
adjustment credit typed by hand has none — there is no rate behind the figure —
and its line derives `taxRateApplied` from the two amounts entered.

### Returns and hold locations do not reach QuickBooks

Goods held in `DAMAGED_HOLD`, `EXPIRED_HOLD` or `SUPPLIER_RETURN_HOLD` are not
sellable and are not synced (§3 — QuickBooks does not own our stock). The ledger
engine refuses to move stock out of any non-sellable location except by
reversing the posting that put it there, so held goods cannot re-enter sellable
inventory through a transfer, an adjustment or a truck load. When a disposal
workflow is built, its effect on QuickBooks is a line on the periodic COGS
journal, not a new object.

---

## 7. Sync mechanics (already scaffolded)

`OutboxEvent`, `SyncJob`, `SyncLog` and `ExternalMapping` exist from Phase 1.
The properties Phase 8 must hold to:

- **An Intuit outage never blocks a sale.** Posting writes an outbox row inside
  the same transaction as the document; the worker is the only thing that talks
  to Intuit.
- **Every push is idempotent.** `ExternalMapping(entityType, entityId)` is
  checked before creating, so a retry updates rather than duplicating.
- **Failures surface.** Retries with exponential backoff, and a failed job is
  visible in the UI with Intuit's own error text.
- **Tokens are encrypted at rest** (`docs/04 §7`) and never reach the client.

---

## 8. What Phase 8 must not do

- Must not write back into SnackLoad from QuickBooks. One direction only, until
  there is a specific reason and a conflict policy written down.
- Must not let a QuickBooks failure change a SnackLoad document. The document is
  posted; the sync is a separate concern (same rule as delivery, `docs/03 §8`).
- Must not derive an invoice/receipt split, a tax figure or a cost from anything
  other than the snapshot the document already carries.
