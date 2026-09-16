# SnackLoad — Relational Data Model

Postgres 16 + Prisma. Every table in the "tenant" set carries `organization_id`
and is indexed on it first. IDs are `cuid2` strings (sortable enough, opaque,
safe in URLs, and generated client-side for offline drafts).

---

## 1. Design decisions that shape the whole schema

### D1. Every stock-holding place is an `InventoryLocation`
A warehouse and a truck differ in *what they are*, not in *how stock moves*. So
`InventoryLocation(kind = WAREHOUSE | VEHICLE)` is the thing the ledger points at,
and `Warehouse` / `Vehicle` hold their own attributes and reference it 1:1.

Result: one balance table, one ledger, one transfer routine. Adding a third kind
(consignment cooler, 3PL) later is a new enum value, not a new subsystem.

### D2. Quantities are integer base units, everywhere
`InventoryBalance.quantity`, every `InventoryTransactionLine.quantityDelta`, and
every `*.baseQuantity` are **signed integers in the product's base unit**.
Packaging lives in `ProductUom`. See `02-inventory-and-money-rules.md §2`.

### D3. `ProductUom` is the only source of packaging truth
Each product gets a base UoM row with `baseUnitsPerUom = 1` at creation. A case,
box, pack, or tray is another row. There is no `unitsPerCase` column to drift out
of sync — "case quantity" on an import maps to the CASE row's factor.

### D4. Users are global; membership is per-organization
A person may work for two distributors (or an owner may run two companies).
`User` holds identity and credentials with a globally unique email;
`Membership(userId, organizationId, roleId)` grants access and carries the
employment-shaped fields. A `Session` pins one active organization.

### D5. Cached aggregates are always recomputable
`InventoryBalance.quantity` and `Customer.balance` are caches, written in the same
transaction as their ledger rows. Each has a documented recompute query and a test
asserting cache == ledger. We never treat them as the source of truth.

### D6. Documents are numbered by a locked sequence row
`DocumentSequence(organizationId, docType)` incremented with `SELECT … FOR UPDATE`
inside the writing transaction. Concurrent runners cannot mint the same receipt
number. `MAX(number)+1` is not acceptable.

---

## 2. Tenancy & identity

```
Organization ─┬─< Membership >─ User ─< Session
              ├─< Role ─< RolePermission
              ├─< Invitation
              └─< AuditLog
```

**Organization** — `id, name, slug(unique), legalName, email, phone, addressLine1/2,
city, state, postalCode, country, timezone, currency(default USD), logoUrl,
receiptFooter, onboardingStepsJson, settingsJson, plan, status, createdAt, updatedAt`

**User** — `id, email(unique, citext-lowered), passwordHash, passwordAlgo,
firstName, lastName, phone, avatarUrl, status(ACTIVE|DISABLED),
lastLoginAt, failedLoginCount, lockedUntil, createdAt, updatedAt`
*Credentials are global; authorization is not.*

**Membership** — `id, organizationId, userId, roleId, status(ACTIVE|SUSPENDED|REMOVED),
employeeCode, defaultVehicleId?, defaultRouteTemplateId?, joinedAt, removedAt`
Unique `(organizationId, userId)`.

**Role** — `id, organizationId, key, name, description, isSystem, createdAt`
Unique `(organizationId, key)`. Seeded per org: `owner`, `admin`, `runner`,
`warehouse`, `office`. `isSystem` roles cannot be deleted, only extended in V2.

**RolePermission** — `id, roleId, permission` — unique `(roleId, permission)`.
Permission strings only. See `04-authorization.md`.

**Invitation** — `id, organizationId, email, roleId, tokenHash, invitedByUserId,
expiresAt, acceptedAt, acceptedByUserId, revokedAt`

**Session** — `id, userId, organizationId, tokenHash(unique), client(WEB|NATIVE|API),
userAgent, ipAddress, expiresAt, lastUsedAt, revokedAt, createdAt`
The token itself is never stored. See `04 §2`.

---

## 3. Catalog

**Supplier** — `id, organizationId, name, accountNumber, contactName, phone, email,
address…, leadTimeDays, active, notes` — unique `(organizationId, name)`.

**ProductCategory** — `id, organizationId, name, parentId?, sortOrder, active`.

**Product** — `id, organizationId, sku, upc?, name, description, brand,
categoryId?, supplierId?, baseUomCode, costPerBaseUnit numeric(16,6),
reorderPointBaseUnits int, taxable bool, active bool, imageUrl, weightGrams,
notes, createdAt, updatedAt`
Unique `(organizationId, sku)`; unique partial `(organizationId, upc) WHERE upc IS NOT NULL`.

> Cost is stored **per base unit** at six decimals so that `$18.00 / 12 bags` and
> `$19.99 / 12 bags` are both exact enough to survive aggregation into COGS.

**ProductUom** — `id, organizationId, productId, code(EACH|CASE|BOX|PACK|TRAY|CUSTOM),
label, baseUnitsPerUom int > 0, price numeric(12,4)?, barcode?, isBase bool,
isDefaultSaleUom bool, sortOrder, active`
Unique `(productId, code)`; unique partial one `isBase` and one `isDefaultSaleUom`
per product. Standard unit price = the base row's `price`; standard case price =
the CASE row's `price`.

**PriceGroup** — `id, organizationId, name, description, active`.
**PriceGroupPrice** — `id, organizationId, priceGroupId, productId, productUomId?,
price, effectiveFrom, effectiveTo?` — a null `productUomId` means "any UoM,
price is per base unit × factor".
**CustomerPrice** — same shape, keyed on `customerId`. Wins over price group.
**Promotion** *(reserved, Phase 5)* — `id, organizationId, name, productId?,
categoryId?, priceGroupId?, discountType, discountValue, startsAt, endsAt, active`.

Resolution order is defined once, in the domain layer:
`manual override → promotion → customer price → price-group price → ProductUom.price`.

---

## 4. Customers

**Customer** — `id, organizationId, accountNumber, name, parentCompany,
addressLine1/2, city, state, postalCode, latitude numeric(9,6), longitude numeric(9,6),
phone, email, priceGroupId?, paymentTermsCode(COD|NET7|NET15|NET30|NET60),
creditLimit numeric(14,4)?, taxExempt bool, taxExemptId, taxRateId?,
balance numeric(14,4) default 0, deliveryInstructions, notes, active,
lastVisitAt, nextDueOn, createdAt, updatedAt`
Unique `(organizationId, accountNumber)`. Index on `(organizationId, active, name)`
and a trigram index on `name` for search.

**CustomerContact** — `id, organizationId, customerId, name, title, phone, email,
isPrimary, notes`.

**TaxRate** — `id, organizationId, name, rate numeric(9,6), isDefault, active`.

---

## 5. Inventory

```
InventoryLocation ─┬─ Warehouse (1:1)
                   └─ Vehicle   (1:1)
       │
       ├─< InventoryBalance >─ Product
       └─< InventoryTransactionLine >─ InventoryTransaction
```

**InventoryLocation** — `id, organizationId, kind(WAREHOUSE|VEHICLE), name, code, active`.
**Warehouse** — `id, organizationId, locationId(unique), address…, isPrimary, notes`.
**Vehicle** — `id, organizationId, locationId(unique), name, truckNumber,
licensePlate, assignedUserId?, active, notes` — unique `(organizationId, truckNumber)`.

**InventoryBalance** — `id, organizationId, locationId, productId,
quantity int, avgUnitCost numeric(16,6), updatedAt` — unique `(locationId, productId)`.
*Cache. Recomputable from the ledger.*

**InventoryTransaction** — `id, organizationId, type, occurredAt, createdByUserId,
referenceType, referenceId, reasonCode?, notes, idempotencyKey?, reversalOfId?, createdAt`
`type ∈ { SUPPLIER_RECEIPT, TRUCK_LOAD, TRUCK_UNLOAD, TRANSFER, SALE, CUSTOMER_RETURN,
DAMAGE, EXPIRED, MISSING, SAMPLE, CORRECTION, COUNT_ADJUSTMENT, REVERSAL }`

**InventoryTransactionLine** — `id, organizationId, transactionId, productId,
locationId, quantityDelta int (signed, base units), unitCost numeric(16,6),
balanceAfter int, notes`
Index `(organizationId, productId, locationId)` and `(transactionId)`.

**Receiving** / **ReceivingItem** — supplier shipment header + lines
(`productId, productUomId, quantity, baseQuantity, unitCost, lineCost`),
linked 1:1 to the `SUPPLIER_RECEIPT` transaction it posted.

**TruckLoad** / **TruckLoadItem** — `direction(LOAD|UNLOAD)`, `vehicleId`,
`routeId?`, `runnerUserId`, `status(DRAFT|CONFIRMED|CANCELLED)`, linked 1:1 to the
`TRUCK_LOAD`/`TRUCK_UNLOAD` transaction. Draft loads hold no stock; confirming posts.

---

## 6. Routes

**RouteTemplate** — `id, organizationId, name, code, color, dayOfWeek?,
defaultRunnerUserId?, defaultVehicleId?, active, notes`.

**CustomerSchedule** — `id, organizationId, customerId, routeTemplateId,
frequency(WEEKLY|BIWEEKLY|TRIWEEKLY|MONTHLY|CUSTOM), intervalDays?, dayOfWeek,
weekOfCycle?, sequence, windowStart, windowEnd, active, lastServicedOn, nextDueOn`
*This is what "14 accounts due Tuesday" queries.*

**Route** — `id, organizationId, routeTemplateId?, serviceDate(date), name,
runnerUserId, vehicleId?, status(PLANNED|IN_PROGRESS|COMPLETED|CANCELLED),
startedAt, completedAt, plannedStops, plannedMiles numeric(9,2),
plannedMinutes, actualMiles, startOdometer, endOdometer, notes`
Unique `(organizationId, routeTemplateId, serviceDate)` when a template is used.

**RouteStop** — `id, organizationId, routeId, customerId, sequence,
status(PENDING|EN_ROUTE|ARRIVED|COMPLETED|SKIPPED|NO_SALE|STORE_CLOSED|RESCHEDULED),
plannedArrivalAt, arrivedAt, completedAt, distanceMiles, durationMinutes,
outcomeReason, rescheduledToDate, notes`
Unique `(routeId, customerId)`; index `(routeId, sequence)`.

**RouteAssignmentHistory** — `id, organizationId, routeId, routeStopId?,
fromUserId?, toUserId, reason, createdByUserId, createdAt`
*Reassigning Mike's stops to Sarah appends here; the original route is never rewritten.*

**RouteCloseout** — `id, organizationId, routeId(unique), status(OPEN|SUBMITTED|APPROVED|DISPUTED),
submittedAt, submittedByUserId, reviewedAt, reviewedByUserId,
salesTotal, returnsTotal, expectedCash, actualCash, checkTotal, cardTotal, achTotal,
onAccountTotal, cashVariance, notes`
**RouteCloseoutItem** — `closeoutId, productId, expectedQuantity, countedQuantity,
varianceQuantity, varianceValue`.

---

## 7. Sales, receipts, payments, returns

**Sale** — `id, organizationId, saleNumber, customerId, routeId?, routeStopId?,
soldByUserId, status(DRAFT|COMPLETED|VOIDED), occurredAt,
subtotal, discountTotal, taxTotal, total, amountPaid, balanceDue numeric(14,4),
dueDate, paymentTermsCode, taxExempt, notes,
idempotencyKey, inventoryTransactionId?, voidedAt, voidedByUserId, voidReason,
createdAt, updatedAt`
Unique `(organizationId, saleNumber)`, unique `(organizationId, idempotencyKey)`.
Index `(organizationId, customerId, occurredAt)` and a partial index on
`balanceDue > 0` for AR queries.

**SaleItem** — `id, organizationId, saleId, productId, productUomId,
productNameSnapshot, skuSnapshot, uomLabelSnapshot,
quantity int, baseQuantity int, unitPrice numeric(12,4),
lineSubtotal, discountAmount, taxAmount, lineTotal,
unitCostAtSale numeric(16,6), priceSource(STANDARD|GROUP|CUSTOMER|PROMO|MANUAL)`
*Snapshots mean a renamed product never rewrites last year's receipts.
`unitCostAtSale` is what makes profitability reports possible and stable.*

**Receipt** — `id, organizationId, saleId(unique), receiptNumber, issuedAt,
signatureId?, pdfPath?, emailedAt, textedAt, printedAt, version`.

**Signature** — `id, organizationId, saleId?, returnId?, signerName,
imagePng(bytes), capturedAt, deviceInfo`.

**Payment** — `id, organizationId, customerId, method(CASH|CHECK|CARD|ACH|OTHER),
amount numeric(14,4), unappliedAmount numeric(14,4), receivedAt, receivedByUserId,
routeStopId?, checkNumber, referenceNumber, processorRef, notes,
status(POSTED|REVERSED), reversedAt, reversedByUserId, reversalOfId?,
idempotencyKey` — unique `(organizationId, idempotencyKey)`.

**PaymentAllocation** — `id, organizationId, paymentId, saleId, amount, createdAt`.
Invariant: `SUM(allocations) + unappliedAmount = payment.amount`.

**Return** — `id, organizationId, returnNumber, customerId, saleId?, routeStopId?,
createdByUserId, occurredAt, reason(EXPIRED|DAMAGED|WRONG_ITEM|UNSOLD|SWAP|OTHER),
disposition(TRUCK|WAREHOUSE|DESTROY),
financialAction(REFUND|ACCOUNT_CREDIT|REPLACEMENT|CREDIT_MEMO|NONE),
subtotal, taxTotal, total, status(COMPLETED|VOIDED),
inventoryTransactionId?, creditMemoId?, idempotencyKey, notes`
**ReturnItem** — `returnId, productId, productUomId, quantity, baseQuantity,
unitPrice, lineTotal, reason, restock bool`.

**CreditMemo** — `id, organizationId, customerId, number, returnId?, amount,
remainingAmount, status(OPEN|APPLIED|VOIDED), issuedAt, notes`.
**CreditMemoApplication** — `id, organizationId, creditMemoId, saleId, amount, appliedAt`.

---

## 8. Imports, integrations, operations

**ImportJob** — `id, organizationId, type(PRODUCTS|CUSTOMERS), fileName, fileSize,
storagePath, status(UPLOADED|MAPPING|VALIDATING|PREVIEW|IMPORTING|COMPLETED|CANCELLED|FAILED),
mode(CREATE_ONLY|UPDATE_ONLY|UPSERT), matchKey(SKU|UPC|ACCOUNT_NUMBER),
columnMapJson, totalRows, readyRows, warningRows, errorRows, importedRows,
skippedRows, createdByUserId, startedAt, completedAt, summaryJson`

**ImportRow** — `id, organizationId, importJobId, rowNumber, rawJson,
normalizedJson, status(PENDING|READY|WARNING|ERROR|IMPORTED|SKIPPED),
action(CREATE|UPDATE|SKIP), messagesJson, targetType, targetId`
*Rows persist after the job so the audit trail answers "where did this price come from".*

**IntegrationConnection** — `id, organizationId, provider(QUICKBOOKS_ONLINE),
status(CONNECTED|DISCONNECTED|EXPIRED|ERROR), realmId, companyName,
accessTokenEncrypted, refreshTokenEncrypted, tokenExpiresAt, refreshExpiresAt,
connectedByUserId, connectedAt, lastSyncAt, settingsJson, lastError`
Unique `(organizationId, provider)`. Tokens are AES-256-GCM sealed; see `04 §7`.

**ExternalMapping** — `id, organizationId, provider, entityType, localId,
externalId, externalSyncToken, lastSyncedAt`
Unique `(organizationId, provider, entityType, localId)` **and**
`(organizationId, provider, entityType, externalId)`.
*This table is why we never re-match on names.*

**SyncJob** — `id, organizationId, provider, entityType, localId, operation,
status(PENDING|IN_PROGRESS|SYNCED|FAILED|RETRYING|NEEDS_ATTENTION),
attempts, nextAttemptAt, lastError, payloadJson, createdAt, completedAt`
Index `(status, nextAttemptAt)` drives the worker.
**SyncLog** — `id, organizationId, syncJobId, attempt, level, message,
requestJson, responseJson, createdAt`.

**OutboxEvent** — `id, organizationId, type, payloadJson, status, attempts,
availableAt, createdAt, processedAt` — written in the same transaction as the
business change; the dispatcher fans out to `SyncJob` and `Notification`.

**Notification** — `id, organizationId, userId?, type, severity, title, body,
dataJson, readAt, createdAt`.

**AuditLog** — `id, organizationId, userId?, action, entityType, entityId,
beforeJson, afterJson, ipAddress, userAgent, createdAt`
Index `(organizationId, entityType, entityId, createdAt)`.

**DocumentSequence** — `id, organizationId, docType(SALE|RECEIPT|RETURN|CREDIT_MEMO|
RECEIVING|TRUCK_LOAD|PAYMENT), prefix, nextNumber, padTo` — unique
`(organizationId, docType)`.

---

## 9. Deletion policy

| Entity | Removal mechanism |
|---|---|
| Sale, Payment, Return, CreditMemo, Receipt | **Void / reverse only.** A reversing inventory transaction is posted; status flips; rows remain. |
| InventoryTransaction | **Never mutated.** Corrections are new transactions of type `CORRECTION` or `REVERSAL`. |
| Product, Customer, Vehicle, Supplier, User membership | `active = false`. Referenced history keeps working. |
| Route, RouteStop | `CANCELLED` / `RESCHEDULED` status. |
| ImportJob, Notification, Session | Hard delete permitted (non-financial, non-historical). |

There is no `DELETE FROM sale` path in the service layer. The Prisma extension
blocks `delete`/`deleteMany` on financial models outright.

---

## 10. Index strategy (the queries that must stay fast on a phone)

| Query | Index |
|---|---|
| Today's route for a runner | `Route(organizationId, runnerUserId, serviceDate)` |
| Stops in order | `RouteStop(routeId, sequence)` |
| Truck stock for a load screen | `InventoryBalance(locationId, productId)` |
| Product search / barcode scan | `Product(organizationId, sku)`, `Product(organizationId, upc)`, trigram on `name` |
| Customer AR | partial index `Sale(organizationId, customerId) WHERE balanceDue > 0` |
| Aging report | `Sale(organizationId, dueDate) WHERE status='COMPLETED' AND balanceDue > 0` |
| Ledger for one product | `InventoryTransactionLine(organizationId, productId, locationId)` |
| Sync worker | `SyncJob(status, nextAttemptAt)` |
