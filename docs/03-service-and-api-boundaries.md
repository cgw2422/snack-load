# SnackLoad — Service & API Boundaries

---

## 1. The service contract

Every service function has this shape:

```ts
type AuthContext = {
  userId: string
  organizationId: string
  membershipId: string
  roleKey: string
  permissions: ReadonlySet<Permission>
  sessionId: string
  requestId: string
  ip?: string
  userAgent?: string
}

async function doThing(ctx: AuthContext, input: DoThingInput): Promise<DoThingResult>
```

Rules:
- `ctx` is always first and always derived from the session — never from the request body.
- `input` is parsed by a Zod schema that lives in `src/lib/schemas/**` and is shared
  verbatim by the REST handler and the Server Action.
- The return value is a plain serializable DTO: no Prisma models, no `Decimal`
  instances, no `Date` objects. Money is a decimal **string**; timestamps are ISO 8601.
  This is what lets the same payload feed RSC, `fetch`, and a native client.
- Permission checks happen **inside** the service, at the top. A transport layer
  that forgets to check is therefore still safe.
- Errors are typed (`AppError` with a `code`, HTTP status, and safe message).
  Internal details never reach the client.

## 2. Service modules

```
server/services/
  auth.service.ts          register org, login, logout, sessions, invitations
  organization.service.ts  company profile, settings, onboarding state
  user.service.ts          members, roles, invite, deactivate
  product.service.ts       catalog CRUD, UoMs, pricing
  pricing.service.ts       resolve price for (customer, product, uom, qty)
  customer.service.ts      accounts, contacts, bulk actions
  import.service.ts        upload → map → validate → preview → commit
  inventory.service.ts     ledger posting, balances, adjustments, transfers
  receiving.service.ts     supplier receipts
  truckload.service.ts     load/unload, suggested load
  route.service.ts         templates, schedules, build/optimize, assignment
  routerun.service.ts      runner workflow: start, arrive, complete, closeout
  sale.service.ts          cart → checkout → void
  payment.service.ts       record, allocate, reverse
  receipt.service.ts       render, email, text, pdf
  return.service.ts        returns and credit memos
  report.service.ts        every report, one query builder
  notification.service.ts
  audit.service.ts
  integrations/quickbooks/ connection, mapping, sync worker
```

`domain/` beneath them holds the pure math: `money.ts`, `uom.ts`, `pricing.ts`,
`tax.ts`, `allocation.ts`, `aging.ts`, `closeout.ts`, `routeOptimize.ts`.
Those functions take primitives and return primitives. They are where the
regression tests bite hardest, and they can be lifted into a React Native bundle
unchanged if we ever want optimistic client-side totals.

## 3. Two transports, one brain

### Server Actions (web only)
```ts
'use server'
export async function checkoutAction(raw: unknown) {
  const ctx = await requireAuth()               // throws → redirect to /login
  const input = checkoutSchema.parse(raw)
  const result = await saleService.checkout(ctx, input)
  revalidatePath(`/routes/${result.routeId}`)
  return result
}
```

### REST (`/api/v1/**`) — the native contract
```
POST   /api/v1/auth/login                  → { token, expiresAt, user, organization }
POST   /api/v1/auth/logout
GET    /api/v1/me
GET    /api/v1/products?search=&page=
GET    /api/v1/customers/:id
GET    /api/v1/routes/today
POST   /api/v1/routes/:id/stops/:stopId/arrive
POST   /api/v1/sales                        (Idempotency-Key header)
POST   /api/v1/payments                     (Idempotency-Key header)
POST   /api/v1/inventory/transfers
GET    /api/v1/reports/sales?from=&to=
```

A single wrapper does auth + parse + error mapping:

```ts
export const POST = handler(saleSchema, async (ctx, input) =>
  saleService.checkout(ctx, input))
```

Auth accepts `Authorization: Bearer <token>` **or** the session cookie — the same
token, two transports (see `04 §2`). Versioning is in the path so a shipped native
app never breaks when the web app moves on.

**The rule that keeps this honest:** the REST layer is not a parallel
implementation. It calls the same service function the Server Action calls. If a
handler contains an `if` about business state, it is in the wrong file.

## 4. Reads in RSC

Server Components may call read-only services directly — that is the point of RSC
and it removes a network hop on mobile:

```tsx
const ctx = await requireAuth()
const stops = await routeService.getTodayForRunner(ctx)
```

Writes never go this way, so validation, audit, and cache revalidation have exactly
one home.

## 5. Import pipeline

A staged, resumable state machine — never a single blocking parse:

```
UPLOAD ──► MAPPING ──► VALIDATING ──► PREVIEW ──► IMPORTING ──► COMPLETED
   file stored     user maps        per-row       user reviews    batched
   header sniffed  columns +        rules run     + fixes inline  commit
                   match key        into ImportRow
```

- **Mapping** is explicit and fuzzy-suggested. `"Item Description" → Product Name`,
  `"Location" → Store Name`. Incoming headers never have to match ours.
- **Validation** writes one `ImportRow` per source row with
  `status ∈ READY | WARNING | ERROR` and structured messages. Detected: missing
  required fields, duplicate SKU/UPC/account number inside the file, collision with
  existing records, bad ZIP, bad email, non-numeric money, unknown route/runner.
- **Preview** shows counts (found / ready / warnings / errors), lets the user fix a
  cell inline (re-validating just that row), skip invalid rows, download an error
  CSV, or cancel.
- **Commit** runs in chunks inside transactions; each row's outcome is written back
  to its `ImportRow`. A crash mid-import is resumable because progress is per-row,
  not in memory.
- **Update mode** matches on the declared key (SKU / UPC / account number) and
  patches only the columns present in the file. Absent columns are left alone —
  a price-list upload must not blank out descriptions.

**Reference resolution (the dangerous part).** When a customer file names a route
(`Tuesday`) or a runner (`Mike`), the importer resolves against existing records
case-insensitively and presents an explicit mapping step for anything ambiguous or
unknown. The user chooses *create new* or *map to existing*, per distinct value,
once. Unresolved references mark rows `WARNING` and block them. The importer never
silently creates users or routes.

## 6. Integration layer

```ts
interface AccountingProvider {
  readonly key: 'quickbooks_online'
  connect(ctx, code, realmId): Promise<Connection>
  refresh(connection): Promise<Connection>
  pushCustomer(ctx, customerId): Promise<ExternalRef>
  pushProduct(ctx, productId): Promise<ExternalRef>
  pushSale(ctx, saleId): Promise<ExternalRef>
  pushPayment(ctx, paymentId): Promise<ExternalRef>
  pushCreditMemo(ctx, creditMemoId): Promise<ExternalRef>
}
```

Flow: business write commits → `OutboxEvent` → dispatcher creates a `SyncJob` →
worker claims it (`FOR UPDATE SKIP LOCKED`), calls the provider, records a
`SyncLog`, and on failure applies exponential backoff
(1m, 5m, 15m, 1h, 6h, 24h) before landing in `NEEDS_ATTENTION` for a human.

Identity always flows through `ExternalMapping`. Dependencies are ordered — a sale
will not push until its customer and products have external IDs, and the worker
enqueues those prerequisites automatically.

Nothing in this path can block or roll back an operational write. A sale in a gas
station succeeds whether or not Intuit is reachable.

## 7. Error model

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no/expired session |
| `FORBIDDEN` | 403 | authenticated, lacks permission |
| `NOT_FOUND` | 404 | absent, or belongs to another org (indistinguishable on purpose) |
| `VALIDATION_FAILED` | 422 | Zod issues, field-keyed |
| `INSUFFICIENT_STOCK` | 409 | includes product, requested, available |
| `CONFLICT` | 409 | version/state conflict |
| `RATE_LIMITED` | 429 | |
| `INTERNAL` | 500 | logged with requestId; message is generic |

A cross-tenant read returns **404, not 403** — confirming existence is itself a leak.

## 8. Messaging (email and SMS)

Two interfaces, `EmailProvider` and `SmsProvider` in `src/server/messaging`, and
nothing else in the codebase names a vendor. Configuration picks the adapter:

| Variable | Effect |
|---|---|
| `EMAIL_PROVIDER_URL` / `SMS_PROVIDER_URL` | JSON-over-HTTP adapter, bearer token |
| unset | console adapter — logs the message, reports success |

The console adapter is refused in production: "every receipt said Sent" is a
worse failure than a button that errors on day one.

**`send` never throws for a delivery failure.** A bounced address, a suppressed
recipient, a provider timeout — all come back as `{ ok: false, error }`, are
written to `receipt_delivery` as a FAILED row with the provider's own wording,
and are shown to the person who pressed Send. The sale is not touched, and
`receipt.emailedAt` is not set. The money moved at the counter; whether the
email landed is a separate fact, and unwinding a posted transaction because an
SMTP server was down would be the far worse bug (`02 §A5`).

Texts carry a **link, not an attachment**. MMS is expensive, unreliable across
carriers, and unreadable on a good fraction of the phones a store clerk owns.

### Printing

Producing document bytes and getting them onto paper are separate problems.
`renderReceiptPdf` returns bytes in two layouts — US Letter and a continuous
80 mm roll sized to its content — and knows nothing about printers. The browser
can only offer a print dialog; a native app will drive a Bluetooth thermal
printer directly. Both consume the same bytes, so neither is a rewrite of the
other (`05 §6`).

## 9. Reporting

`src/server/reports/**`. One module per report, one registry, three rules.

**Reports read posted transactions.** There is no reporting table, no nightly
rollup, and no counter incremented on write. Every figure is derived from
`sale`, `sale_item`, `payment` and `inventory_transaction_line` when it is
asked for. A second set of totals is how a system starts telling two stories
about the same month, and the volumes here — thousands of sales a year, not
millions — do not come close to needing one. The single cache that exists,
`inventory_balance`, is provably equal to the ledger, and the inventory report
*checks* that with `findBalanceDrift` rather than assuming it: on disagreement
it says so at the top instead of reporting a number nobody can reconcile.

If a report ever does need pre-aggregation, the answer is a materialised view
refreshed from the same transactions — never a table maintained by application
writes.

**Every financial report states what it measures.** `definition` is a required
field, not documentation. "Profit" means half a dozen different numbers to half
a dozen people, and a distributor who reads gross profit as net profit will
misprice a route. So the gross-profit report says *GROSS profit, not net*, lists
what is excluded (fuel, wages, vehicle costs, rent, insurance, shrinkage) before
what is included, and carries that sentence into the CSV, the spreadsheet and
the PDF. The aging report says its buckets run from the **due date**, not the
invoice date. The route report separates **billed** from **collected**.

**Money is decimal strings, end to end.** Aggregation happens in Postgres
`numeric` and is cast to `text` before it crosses into JavaScript. Two
consequences worth knowing:

- Ordering must be on the numeric aggregate, never on a `::text` column's
  ordinal — `ORDER BY 4 DESC` over a text-cast money column sorts `"772.68"`
  above `"2824.05"`.
- Excel is the one place a decimal string becomes a number, because summing a
  column is the whole reason somebody asked for Excel. That conversion is in
  `export.ts` and nowhere else (`02 §M2`).

### Raw SQL

These are the only aggregate queries in the codebase, and raw SQL bypasses the
tenant extension. Every query passes `organizationId` by hand through
`reportQuery`, which exists so that is one greppable call rather than a habit
(`04 §5`). Exported CSV cells beginning `=`, `+`, `-` or `@` are prefixed with
an apostrophe so a spreadsheet does not execute a store name as a formula.

### Permissions

`report:read` covers volume: sales, customers, inventory, routes, runners.
`report:financial` is required for cost, margin and receivables — a warehouse
user can see what moved without seeing what it earns. `report:export` is
separate again, because letting somebody read a figure on screen is not the same
as letting them walk out with the book.
