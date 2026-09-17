# SnackLoad — Inventory & Money Transaction Rules

These are invariants, not guidelines. Every rule here has a test in
`tests/unit` or `tests/integration`. If a rule and the code disagree, the code is wrong.

---

## 1. Money

### M1 — Money is never a JavaScript `number`
Storage is Postgres `numeric`. Transport is a decimal **string**. Computation is
`decimal.js`. `float`, `parseFloat`, and `Number()` are never applied to a monetary
value.

| Value | Type | Precision |
|---|---|---|
| Line/document amounts, balances, payments | `numeric(14,4)` | 4 dp |
| Unit prices | `numeric(12,4)` | 4 dp |
| Unit costs | `numeric(16,6)` | 6 dp |
| Tax rates | `numeric(9,6)` | 6 dp |

Costs carry six decimals because a case cost divided by a case factor is rarely
exact: `$19.99 / 12 = $1.665833…`. Truncating that to cents drifts COGS by real
money across thousands of lines.

### M2 — Rounding happens at exactly two boundaries
1. **Line extension**: `round(unitPrice × quantity, 2)` → `lineSubtotal`.
2. **Line tax**: `round(taxableBase × taxRate, 2)` → `taxAmount`.

Document totals are the **sum of already-rounded line values**. We never round a
sum of unrounded values, because then `Σ lines ≠ total` on the printed receipt and
the customer notices.

Mode is `ROUND_HALF_UP` (what a person expects; matches QuickBooks' default for
line extensions).

### M3 — Discounts are applied before tax, per line
`taxableBase = lineSubtotal − discountAmount`. A document-level discount is
distributed across taxable lines proportionally, with the rounding remainder
assigned to the largest line so the distributed parts sum exactly to the whole.

### M4 — Tax
`taxAmount = 0` when any of: the customer is tax exempt, the product is not
taxable, or the resolved rate is 0. Otherwise the rate is resolved as
`customer.taxRate → organization default`. Jurisdiction lookup is out of scope;
the resolution function is a single seam where a tax provider can be inserted.

### M5 — Totals identity (asserted on every completed sale)
```
lineTotal      = lineSubtotal − discountAmount + taxAmount
subtotal       = Σ lineSubtotal
discountTotal  = Σ discountAmount
taxTotal       = Σ taxAmount
total          = subtotal − discountTotal + taxTotal
balanceDue     = total − amountPaid − creditsApplied
```
A sale that fails this identity is rejected before commit.

---

## 2. Quantity & units of measure

### Q1 — The base unit is the atom
Every product declares a base unit (bag, bottle, can, bar). **All** stored
quantities — balances, ledger deltas, `baseQuantity` on any line — are signed
integers in base units.

### Q2 — Conversion is `baseQuantity = quantity × uom.baseUnitsPerUom`
Conversion happens once, at the edge, when a line is created. It is never redone
from stored data.

```
Takis Fuego, base unit = BAG, CASE = 12 BAG
  on hand 223 base units  →  displayed "18 cs 7 ea"
  sell 3 CASE             →  baseQuantity 36, balance 187 → "15 cs 7 ea"
```

### Q3 — Display splitting is presentation only
`formatQuantity(223, 12) = "18 cs 7 ea"`. The split is computed for rendering and
never written back. Partial cases are therefore a normal, representable state —
we never force stock into whole cases.

### Q4 — Prices attach to a UoM, not to the base unit
A case price is not required to equal `unitPrice × 12`. Distributors price cases
below the unit-multiple on purpose, and the schema must not fight that.

### Q5 — Changing `baseUnitsPerUom` does not rewrite history
Sale and ledger lines store both `quantity` + `productUomId` **and** the resolved
`baseQuantity`, plus a UoM label snapshot. Re-packing a product next year leaves
last year's receipts and COGS untouched.

---

## 3. The inventory ledger

### L1 — Append-only
`InventoryTransaction` and `InventoryTransactionLine` rows are inserted and never
updated or deleted. A mistake is corrected by a new transaction
(`CORRECTION`) or by a full `REVERSAL` that points back with `reversalOfId`.

### L2 — Conservation for movements
For `TRANSFER`, `TRUCK_LOAD`, and `TRUCK_UNLOAD`, the signed deltas of a
transaction **must sum to zero per product**. Stock is moved, never created.

```
TRUCK_LOAD #881
  −180  Takis  @ Warehouse (Main)     (15 cases)
  +180  Takis  @ Vehicle (Truck #3)
  sum = 0  ✓
```

For `SUPPLIER_RECEIPT` and `CUSTOMER_RETURN` the sum is positive (stock enters the
system). For `SALE`, `DAMAGE`, `EXPIRED`, `MISSING`, `SAMPLE` it is negative
(stock leaves). `CORRECTION` and `COUNT_ADJUSTMENT` may be either.

### L3 — Balance is maintained transactionally under a row lock
Posting a transaction, in **one** Postgres transaction:
1. `SELECT … FOR UPDATE` the affected `InventoryBalance` rows, ordered by
   `(locationId, productId)` — a fixed order, so concurrent postings cannot deadlock.
2. Validate the resulting quantities (rule L4).
3. Insert the transaction + lines, writing `balanceAfter` on each line.
4. Update the balance rows and the moving-average cost.
5. Write the `AuditLog` row and any `OutboxEvent`.

If any step throws, nothing is written. There is no path that writes lines without
updating balances.

### L4 — Negative stock policy
Default: **a movement may not drive a location's balance below zero.** The service
throws `InsufficientStockError` naming the product and the shortfall.

Two deliberate exceptions, both per-organization settings (default off):
- `allowNegativeTruckStock` — a runner sells from a truck whose load was recorded
  late. The sale still posts; a `NEGATIVE_STOCK` notification fires.
- `COUNT_ADJUSTMENT` may always set any value; that is the point of a count.

### L5 — Cost basis is moving average, per location
```
newAvgCost = (qtyOnHand × avgCost + qtyIn × incomingCost) / (qtyOnHand + qtyIn)
```
Outbound lines carry the *current* `avgUnitCost` of the source location, and a sale
copies it to `SaleItem.unitCostAtSale`. COGS is therefore fixed at the moment of
sale and no later price change can retroactively alter a closed month.
FIFO/lot tracking is not implemented; the ledger shape supports adding a lot
dimension later without changing the transaction API.

### L6 — Reconciliation
```sql
SELECT location_id, product_id, SUM(quantity_delta) AS ledger_qty
FROM inventory_transaction_line
GROUP BY 1,2
```
must equal `InventoryBalance.quantity` for every pair. An integration test asserts
this after every scenario, and an admin report exposes it.

---

## 4. Movement paths

```
Supplier ──SUPPLIER_RECEIPT──► Warehouse
Warehouse ──TRUCK_LOAD──► Vehicle
Vehicle ──SALE──► Customer            (leaves the system)
Customer ──CUSTOMER_RETURN──► Vehicle or Warehouse   (restock = true)
Customer ──CUSTOMER_RETURN──► (destroyed)            (restock = false, no +line)
Vehicle ──TRUCK_UNLOAD──► Warehouse
Warehouse ⇄ Warehouse ──TRANSFER──►
Any ──DAMAGE|EXPIRED|MISSING|SAMPLE──► (leaves the system)
```

A sale deducts from the **selling location** — the runner's assigned vehicle when
the sale is on a route, otherwise the warehouse (counter sale). The selling
location is resolved server-side from the route/vehicle assignment, never sent by
the client.

---

## 5. Accounts receivable rules

### A1 — A completed sale with `balanceDue > 0` is an open invoice
There is no separate invoice table. A `Sale` *is* the invoice; `Receipt` is its
printable rendering. This avoids a whole class of "invoice and sale disagree" bugs.

### A2 — `Customer.balance = Σ open sale balances`
A cache of open AR and nothing else. **Credit is deliberately NOT netted into
it.** A store with a $500 invoice and a $100 credit owes $500 and holds $100;
saying they owe $400 is a figure that cannot be reconciled against any document,
because no invoice has been reduced. `getCreditPosition` returns the three
numbers separately — `openInvoices`, `totalCredit`, `net` — and every screen
shows at least the first two.

### A3 — Payment allocation
A payment carries `amount` and `unappliedAmount`. Allocation strategies:
- `OLDEST_FIRST` (default): apply to open sales ascending by `dueDate`, then `occurredAt`.
- `SPECIFIC`: caller supplies `[{saleId, amount}]`.

Invariants:
- `Σ allocations + unappliedAmount = payment.amount`, always.
- No allocation may exceed that sale's remaining `balanceDue`.
- Over-payment is legal and lands in `unappliedAmount` (customer credit on account).
- Partial payment is legal: a $500 sale paid $200 leaves `balanceDue = 300`.

### A4 — Reversal, not deletion
Reversing a payment inserts a mirrored `Payment` with `reversalOfId`, deletes no
allocations, and restores each affected sale's `balanceDue` and the customer
balance. Both rows stay visible in history.

### A5 — Aging buckets are computed from `dueDate`, not `occurredAt`
`Current, 1–30, 31–60, 61–90, 90+`, measured against the report's as-of date. A
sale with `COD` terms has `dueDate = occurredAt`.

---

## 5b. Returns, credits and refunds

**A posted sale is history.** No return edits or deletes a sale line. A return is
a new document that references the original, carries its own number, and posts
its own ledger lines. Afterwards these are all separately answerable: what was
sold, what came back, why, whether stock returned, where it went, what credit
was issued, whether cash was refunded, whether the credit was applied, and who
did each of those things.

### R1 — Two independent axes

**Disposition** is what happens to the goods, and it is **per line** — a return
of three cases can restock two and write one off. **Financial action** is what
happens to the money. Neither implies the other: a damaged case still earns a
credit, and a pricing correction earns one with nothing coming back at all.

| Disposition | Ledger type | Destination |
|---|---|---|
| `RESTOCK_TRUCK` | `CUSTOMER_RETURN_SELLABLE` | the truck the goods left on |
| `RESTOCK_WAREHOUSE` | `CUSTOMER_RETURN_SELLABLE` | the warehouse |
| `DAMAGED` | `CUSTOMER_RETURN_DAMAGED` | `DAMAGED_HOLD` |
| `EXPIRED` | `CUSTOMER_RETURN_EXPIRED` | `EXPIRED_HOLD` |
| `SUPPLIER_RETURN` | `CUSTOMER_RETURN_SUPPLIER` | `SUPPLIER_RETURN_HOLD` |
| `NONE` | — | nothing posted |

### R2 — Returnable quantity is enforced on the server

`sold − Σ(returned on live returns)`, per **sale line**, recomputed inside the
posting path. A voided return releases its units again. The UI shows the cap as
a convenience; it is not the guard.

### R3 — Hold locations, not instant write-off

"We took it back" and "we wrote it off" are two events. Goods with a non-sellable
disposition land in a hold location with `sellable = false`: the ledger records
that they physically returned, and inventory reports exclude them from on-hand
and from value. A damaged case therefore never becomes truck stock again, and
the shrinkage is still visible.

### R4 — A credit is a proportion of what was charged

Never a fresh calculation. `creditForReturn` prorates the original line's
subtotal, discount and **tax** by the units coming back. Returning a whole line
credits it exactly, with no rounding drift. This is what keeps a reversal correct
when the rate, the customer's exemption or the product's taxability has changed
since — the historical basis wins.

### R5 — The credit memo identity

    amount = Σ applications(APPLIED) + refundedAmount + remainingAmount

`remainingAmount` is unspent credit. Applying reduces exactly one invoice's
`balanceDue` and writes a `CreditMemoApplication` saying which and how much.
Allocation settles **the invoice the credit was raised against first**, then
oldest-first — a store looking at the bill in their hand expects that bill to
move.

### R6 — A refund is not a reversed payment

Reversing a payment says the money never arrived. A refund says it arrived and
was given back. `Refund` is its own document with its own number, drawing down
the credit memo it is paid from.

### R7 — Unwinding has an order

A return will not void once its credit has been **applied** or **refunded**:
unwinding it would leave an invoice settled by money that no longer exists. The
dependent document is reversed first (`unapplyCreditMemo`, `voidRefund`), and
the error says so. A credit memo issued by a return is voided by voiding the
return, so the goods go back as well as the money.

### R8 — COGS reverses at the historical cost

`CreditMemoItem.unitCostAtSale` is copied from the sale line, not read from the
product today. A $20 sale that cost $12 and is fully returned moves revenue by
−$20, COGS by −$12 and gross profit by −$8, whatever the supplier has charged
since. A credit with no goods behind it reverses revenue and no cost.

### R9 — Permissions are split

`return:create` (take goods back) is separate from `credit:create` (issue
money), `refund:create` (hand over cash) and the three `*:void` grants. A runner
holds the first two. Anyone who can sell must not thereby be able to empty the
till.

---

## 6. Idempotency & concurrency

### I1 — Every financial write is idempotent
`Sale`, `Payment`, `Return`, `InventoryTransaction`, `TruckLoad` each carry a
client-supplied `idempotencyKey` (UUIDv4) with a unique index scoped to the
organization.

The key is minted when the **cart is created**, not when submit is pressed — so a
retry after a timeout in a dead-zone store reuses the same key.

Replay behaviour: the insert hits the unique constraint, the service catches it,
loads the existing record, and returns it with `replayed: true`. The caller sees a
success and the store is billed once.

### I2 — Ordering prevents deadlock
Any statement that locks multiple rows does so in a deterministic order
(`locationId, productId` for inventory; `dueDate, id` for AR).

### I3 — Document numbers come from a locked sequence
`SELECT … FOR UPDATE` on `DocumentSequence`, increment, use, all inside the same
transaction as the document insert. Two runners checking out simultaneously get
`R-10482` and `R-10483`, never a duplicate.

### I4 — Offline drafts (Phase 9 prerequisite, in place from Phase 1)
A cart is persisted client-side in IndexedDB with its idempotency key. On
reconnect the queue replays; I1 makes replay safe. Because the key is stable and
the server is the sole authority on price, stock, and numbering, a queued sale
cannot double-post and cannot invent a price.

---

## 7. Voiding a sale

Voiding is a compensating action, in one transaction:
1. Assert the sale is `COMPLETED` and the actor holds `sale:void`.
2. Post a `REVERSAL` inventory transaction restoring each line's `baseQuantity` to
   the location it was deducted from, with `reversalOfId` set.
3. Reverse every payment allocation against the sale, returning those amounts to
   each payment's `unappliedAmount`.
4. Recompute `Customer.balance`.
5. Set `status = VOIDED`, `voidedAt`, `voidedByUserId`, `voidReason`.
6. Write an `AuditLog` row with the before/after document.
7. Enqueue a QuickBooks void/credit sync job.

The original sale, its items, and its receipt remain readable forever.

---

## 8. Route closeout arithmetic

```
expectedCash    = Σ payments on this route where method = CASH
actualCash      = counted by the runner
cashVariance    = actualCash − expectedCash

expectedStock(product)  = starting truck balance
                        + loads during the route
                        − sales
                        + customer returns restocked to truck
                        − damage/expired/missing recorded on the route
countedStock(product)   = entered by the runner (optional)
stockVariance           = counted − expected      (valued at avgUnitCost)
```
Submitting a closeout with a stock variance posts a `COUNT_ADJUSTMENT`
transaction, so the ledger stays the single explanation for every unit.
Truck stock may legitimately stay on the truck overnight; unloading is a separate,
optional `TRUCK_UNLOAD`.
