# QuickBooks Object Mapping — the contract Phase 8 implements

Written at the end of Phase 7.5, before any integration code exists, because the
point of finishing returns and credits first was to have a complete financial
document model to map *from*. Nothing here is implemented yet.

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

## 2. Invoice versus Sales Receipt

The split is decided **once, at post time, and recorded** — not recomputed later,
because a sale that was paid in full at the counter and is later credited must
not retroactively become an invoice in QuickBooks.

- `amountPaid == total` when the sale posted → **SalesReceipt**.
- Otherwise → **Invoice**, and the payment (if any) is a separate **Payment**
  object linked to it.

Phase 8 should persist this choice on the outbox event rather than deriving it
from the sale's current state.

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
