# SnackLoad — Architecture Overview

> Load it. Route it. Sell it.
> Inventory. Routes. Sales.

This document is the architectural contract for SnackLoad. Everything else in `docs/`
expands one section of it. Read this first.

---

## 1. What we are building

A multi-tenant SaaS for independent snack & beverage distributors that runs the
physical loop:

```
Supplier → Warehouse → Truck → Store → Cash/AR → QuickBooks
```

The system of record for **operations** (inventory, routes, field sales) is SnackLoad.
The system of record for **accounting** is QuickBooks Online. SnackLoad pushes;
it does not wait on QuickBooks to complete a sale.

## 2. Primary architectural constraint

> The web app is the *first* client, never the *only* client.

Every decision below is downstream of that. A React Native app shipped in 2027 must
use the same database, the same business rules, and the same API — no backend rewrite.

This forces four rules that are non-negotiable:

| # | Rule | Why |
|---|------|-----|
| R1 | Business logic lives in `src/server/services/**`, never in a React component, route handler, or Server Action. | Server Actions are a web-only transport. Native cannot call them. |
| R2 | Every service function takes an explicit `AuthContext` as its first argument and returns plain serializable DTOs. | No ambient request state. A background job, a REST handler, and a Server Action call the identical function. |
| R3 | Authentication is an opaque bearer token, stored in an httpOnly cookie for web and in the Keychain/Keystore for native. | One session table, two transports. No web-only auth primitive (no `next-auth` session coupling). |
| R4 | `/api/v1/**` is a thin, versioned HTTP wrapper over the service layer, and is the *only* way the future native app talks to the backend. | The REST surface is exercised by the web app's own mutations, so it cannot rot. |

### The layer cake

```
┌──────────────────────────────────────────────────────────────┐
│ Clients                                                      │
│   web (Next.js RSC + client components, PWA)                 │
│   future: React Native                                       │
└───────────────┬──────────────────────────┬───────────────────┘
                │ Server Actions / RSC     │ HTTPS + Bearer
                ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│ Transport                                                    │
│   src/app/**/actions.ts   (web only, auth via cookie)        │
│   src/app/api/v1/**       (any client, auth via cookie OR    │
│                            Authorization: Bearer)            │
│   Both do: parse → authenticate → call service → serialize   │
│   Neither contains business rules.                           │
└───────────────┬──────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────┐
│ Services   src/server/services/**                            │
│   (ctx: AuthContext, input: Zod-validated) => DTO            │
│   Owns: permission checks, invariants, transactions,         │
│         audit logging, outbox writes.                        │
└───────────────┬──────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────┐
│ Domain    src/server/domain/**                               │
│   Pure functions, zero I/O: money, tax, pricing, UoM         │
│   conversion, payment allocation, aging buckets.             │
│   100% unit-testable. This is where the arithmetic lives.    │
└───────────────┬──────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────┐
│ Data      Prisma + PostgreSQL                                │
│   Tenant-scoped client extension. Append-only ledgers.       │
└──────────────────────────────────────────────────────────────┘
```

A component may `await` a service directly in an RSC for **reads**. All **writes**
go through a Server Action or REST handler so that validation, audit, and
revalidation happen in exactly one place.

## 3. Stack decisions

| Concern | Choice | Rationale / rejected alternative |
|---|---|---|
| Framework | Next.js 16 (App Router) | RSC gives fast mobile first paint; API routes give the native surface. |
| Language | TypeScript, `strict` | Financial code without types is negligent. |
| Styling | Tailwind CSS v4 | Design tokens as CSS variables; no runtime cost on mobile. |
| DB | PostgreSQL 16 | `numeric` for money, real transactions, row locking, partial indexes. |
| ORM | Prisma | Migrations, `Decimal` mapping, client extensions for tenancy. |
| Validation | Zod | One schema shared by REST body parsing and Server Action input. |
| Money | `decimal.js` + Postgres `numeric(14,4)` | **Never** JS `number`. See `02-inventory-and-money-rules.md`. |
| Auth | Hand-rolled opaque-token sessions | NextAuth/Auth.js couples to web request/response and makes native token issuance awkward. Our need is narrow and the crypto is standard. |
| Password hash | scrypt (Node built-in `crypto`) | No native build step, memory-hard, FIPS-adjacent. Argon2id would need a native module; the hash column is versioned so we can migrate. |
| Tests | Vitest | Fast, TS-native, works for pure domain + DB integration. |
| Background work | Transactional outbox table + worker | A queue service is premature; the outbox survives restarts and gives us at-least-once QuickBooks sync without Redis. |

## 4. Architectural risks, and what we do about them

These are the things that will actually break this product. Each has a mitigation
baked into the schema or the service layer from day one.

### RISK 1 — Floating-point money
**Failure mode:** `0.1 + 0.2` on 40 line items a day × 300 stores = balances that
never reconcile with QuickBooks, and a distributor who stops trusting the app.
**Mitigation:** Money never exists as a JS `number`. Postgres `numeric(14,4)`,
Prisma `Decimal`, `decimal.js` in the domain layer. A lint rule and a test forbid
`parseFloat`/`Number()` on money fields. Rounding is explicit and half-up at the
line-total and tax boundaries only. See `02`.

### RISK 2 — "Cases vs units" modelled as two columns
**Failure mode:** `cases` and `units` as separate integers produces impossible
states (`-1 case, 11 units`), breaks averaging, and makes every report wrong.
**Mitigation:** **All inventory and all ledger math is in integer base units.**
A product declares `unitsPerCase`; UoMs (`EACH`, `CASE`, `BOX`, `PACK`, `TRAY`) are
presentation-and-pricing concerns that convert to base units at the boundary.
`18 cases + 7 bags` is stored as `223`, displayed as `18 cs 7 ea`. See `02 §2`.

### RISK 3 — Inventory as a mutable number
**Failure mode:** `UPDATE stock SET qty = qty - 3` loses history; a variance is
unexplainable; a double-submit silently double-decrements.
**Mitigation:** Append-only `InventoryTransaction` + `InventoryTransactionLine`
ledger, with signed deltas that must sum to zero per transaction for transfers.
`InventoryBalance` is a *derived cache* maintained inside the same DB transaction
under a row lock. A reconciliation query (and a test) asserts
`SUM(ledger) == balance` for every (location, product). See `02 §3`.

### RISK 4 — Tenant leakage
**Failure mode:** one missing `where: { organizationId }` exposes another
distributor's customer list. This is the single highest-severity bug class in
multi-tenant SaaS.
**Mitigation:** Defence in depth —
1. `organizationId` is a required column on every tenant table.
2. A Prisma **client extension** injects `organizationId` into `where` and `data`
   for all tenant models; the raw client is not exported from the app code.
3. Services receive `ctx.organizationId` from the session, **never** from user input.
4. Integration tests attempt cross-org reads/writes and assert they fail.
See `04 §5`.

### RISK 5 — Offline double-posting
**Failure mode:** a runner in a rural store submits a sale, the request times out,
the PWA retries, and the store is billed twice. Inventory is now wrong too.
**Mitigation:** Every mutating write carries a **client-generated `idempotencyKey`**
(UUIDv4 minted when the cart is created, not when it is submitted). A unique index
on `(organizationId, idempotencyKey)` makes a replay a no-op that returns the
*original* result. This is in the schema in Phase 1 even though offline sync lands
in Phase 9 — retrofitting idempotency onto live financial data is not feasible.
See `02 §6`.

### RISK 6 — QuickBooks coupling
**Failure mode:** QuickBooks is down or a token expired, and a runner cannot ring
up a sale inside a gas station.
**Mitigation:** Sync is strictly asynchronous via the outbox. A sale commits
locally, then enqueues a `SyncJob`. Sync failures set a status and surface in an
admin UI; they never roll back or block an operational write. Identity is held by
a durable `ExternalMapping(entityType, localId, provider, externalId)` table —
never by name matching. The provider interface is generic so Xero/Sage can be
added. See `03 §6`.

### RISK 7 — Name-matching on import
**Failure mode:** a spreadsheet says `Mike` and `Tuesday`; a naive importer
creates three users named Mike and four "Tuesday" routes.
**Mitigation:** Import is a staged, resumable job — `ImportJob` + `ImportRow` —
with an explicit mapping/resolution step. Unresolvable references become
**warnings that block the row**, never silent creation. Upsert is keyed on a
declared natural key (SKU/UPC/account number), not on a display name. See `03 §5`.

### RISK 8 — Deleting financial records
**Failure mode:** a deleted sale leaves an orphan payment and an AR balance that
cannot be explained.
**Mitigation:** No hard deletes on financial or inventory records. Sales are
**voided** by posting a reversing inventory transaction and a status change;
payments are **reversed**; customers/products are **deactivated**. `deletedAt`
exists for non-financial rows only. See `01 §9`.

### RISK 9 — Mobile performance on a 4-year-old Android in a dead zone
**Failure mode:** the "app" takes 8 seconds to show the next stop.
**Mitigation:** Mobile-first layouts (not a shrunk desktop grid), RSC for the
data-heavy shell, a service worker that pre-caches the active route + its
customers + the truck's product subset, and IndexedDB-backed cart drafts that
survive a refresh. Route-runner screens have a hard budget: interactive in
< 2.5 s on a mid-tier Android over 3G.

### RISK 10 — Permissions that cannot evolve
**Failure mode:** roles hard-coded as `if (user.role === 'ADMIN')` means custom
roles require touching 200 call sites.
**Mitigation:** Checks are always against a **permission string**
(`sale:create`, `inventory:adjust`), never a role name. Roles are named bundles of
permissions, seeded per organization as rows — so a custom role in V2 is data, not
a deploy. See `04`.

## 5. Repository layout

```
src/
  app/                      route tree (web transport only)
    (auth)/                 login, register, accept-invite
    (app)/                  authenticated shell: dashboard, routes, sell, inventory, more
    api/v1/**               versioned REST — the native-app contract
  components/               presentational React; no data access
  server/
    auth/                   sessions, password hashing, context resolution
    db/                     prisma client + tenant extension
    domain/                 PURE business math (money, uom, pricing, tax, allocation)
    services/               orchestration + persistence + authorization
    integrations/           quickbooks/, accounting provider interface
  lib/                      isomorphic helpers (formatters, zod schemas, types)
prisma/
  schema.prisma
  migrations/
  seed/                     demo organization + realistic data
docs/                       this folder
tests/
  unit/                     domain math
  integration/              services against a real Postgres
```

Dependency direction is strictly downward: `app → services → domain → (nothing)`.
`domain` importing from `app` or `services` is a build error by convention and is
checked in review.

## 6. Non-goals for V1

Preserved architecturally, deliberately not built yet:

- Turn-by-turn navigation (we hand off to Apple/Google Maps).
- Direct card/ACH *processing* (we record the tender; `Payment.processorRef` and a
  provider interface are reserved for Stripe).
- Bluetooth thermal printing from the browser (receipt renders to an 80mm-friendly
  layout now; native driver later).
- Full offline write-sync (idempotency keys, the outbox, and draft persistence are
  in place so it is an additive change, not a rewrite).
- Custom role editing UI (the permission model already supports it).
