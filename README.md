<div align="center">

# SnackLoad

**Load it. Route it. Sell it.**
Inventory · Routes · Sales

Route sales and distribution management for independent snack and beverage distributors.

</div>

---

## What this is

A multi-tenant SaaS that runs the loop an independent distributor actually works:

```
Supplier → Warehouse → Truck → Store → Cash/AR → QuickBooks
```

Mobile-first, because the primary user is standing inside a gas station with one
hand free. Desktop is a genuinely separate layout for imports, reports and
administration — not the phone screen stretched.

The promise it is being built to keep:

> I know what I have. I know what's on every truck. I know where every driver is
> supposed to go. I know what every store bought. I know what every store owes me.
> I can give them a receipt immediately. I know how much I'm selling and making.
> And my accounting ends up in QuickBooks.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Foundation — schema, auth, roles, tenancy, app shell, demo data | **Shipped** |
| 2 | Products & stores, CSV/XLSX import, bulk editing | Next |
| 3 | Inventory: warehouses, trucks, ledger, receiving, truck loads | Posting engine shipped; UI next |
| 4 | Routes: templates, schedules, optimisation, runner workflow | Planned |
| 5 | Sales: search, barcode, cart, pricing, tax, checkout | Planned |
| 6 | Receipts & AR: signatures, PDF, payments, allocation, aging | Planned |
| 7 | Reports: sales, profitability, inventory, route, runner, AR | Planned |
| 8 | QuickBooks Online: OAuth, mapping, sync worker | Planned |
| 9 | PWA & offline resilience | Planned |

Destinations for unshipped phases are reachable in the app and say which phase
they belong to, rather than pretending to be empty features.

## Read this before changing anything

The design is written down, and the code is built to it:

| Document | What it settles |
|---|---|
| [docs/00-architecture.md](docs/00-architecture.md) | Layers, stack, and the ten risks that would sink this product |
| [docs/01-data-model.md](docs/01-data-model.md) | The relational model and the decisions that shape it |
| [docs/02-inventory-and-money-rules.md](docs/02-inventory-and-money-rules.md) | **The invariants.** Money, units, the ledger, AR, idempotency |
| [docs/03-service-and-api-boundaries.md](docs/03-service-and-api-boundaries.md) | The service contract, both transports, imports, integrations |
| [docs/04-authorization.md](docs/04-authorization.md) | Credentials, sessions, permissions, tenant isolation, secrets |
| [docs/05-pwa-and-native.md](docs/05-pwa-and-native.md) | Mobile specifics, offline posture, native-app compatibility |
| [docs/06-roadmap.md](docs/06-roadmap.md) | Phases and their exit criteria |

Three rules carry most of the weight:

1. **Money is never a JavaScript `number`.** Postgres `numeric`, `decimal.js`,
   decimal strings on the wire.
2. **Quantities are integer base units.** `18 cases + 7 bags` is `223`. Packaging
   is a `ProductUom`, and the split back out is presentation only.
3. **Business logic lives in `src/server/services/**`,** takes an `AuthContext`
   first, and returns plain JSON. Server Actions and `/api/v1` are two transports
   over the same functions — which is what lets a native app reuse this backend.

## Running it

Requires Node 22+, pnpm and PostgreSQL 16.

```bash
pnpm install
cp .env.example .env          # then fill in DATABASE_URL and two secrets
openssl rand -base64 32       # SESSION_SECRET
openssl rand -base64 32       # ENCRYPTION_KEY

pnpm db:migrate               # create the schema
pnpm db:seed                  # demo distributor with eight weeks of history
pnpm dev
```

The seed builds Valley Snack Distributors: 12 SKUs, 12 stores, three route
runners with their own trucks, weekly routes, ~100 sales, real receivables, and
an inventory ledger that reconciles. Sign in with any of:

| Email | Role |
|---|---|
| `owner@snackload.demo` | Owner — full access |
| `mike@snackload.demo` | Route runner |
| `sarah@snackload.demo` | Route runner (today's in-progress route) |
| `dana@snackload.demo` | Warehouse |
| `pat@snackload.demo` | Office / accounting |

Password for all of them: `snackload123`

## Commands

```bash
pnpm dev            # development server
pnpm build          # production build
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest: unit + integration
pnpm lint

pnpm db:migrate     # create and apply a migration
pnpm db:seed        # rebuild the demo organization
pnpm db:studio      # browse the database
pnpm icons          # regenerate PWA icons from public/brand/icon.svg
```

Tests need a database whose name contains `test`; `.env.test` points at
`snackload_test` and the suite refuses to run against anything else.

## Layout

```
src/
  app/(auth)/          register, login, accept invite
  app/(app)/           the authenticated shell and its pages
  app/api/v1/          versioned REST — the future native app's contract
  components/          presentational React; no data access
  server/
    auth/              sessions, scrypt, AuthContext
    db/                Prisma client + the tenant-scoping extension
    domain/            pure business math — money, uom, sale totals
    services/          orchestration, authorization, transactions, audit
  lib/                 isomorphic helpers, Zod schemas, permissions
prisma/
  schema.prisma        54 models
  seed/                the demo distributor
tests/
  unit/                domain math
  integration/         services against a real Postgres
```

## Testing posture

Financial and inventory integrity outrank cosmetic perfection. The suite covers
the things that would quietly cost a distributor money:

- decimal arithmetic, rounding boundaries, and discounts that sum exactly
- base-unit conversion and partial cases
- sale totals, the `Σ lines = total` identity, and tax
- ledger conservation, negative-stock refusal, moving-average cost, and
  `SUM(ledger) == balance` under concurrent posting
- document numbering under concurrency
- idempotent financial writes
- tenant isolation attempted from every direction
- permissions enforced in the service layer, not the UI

Integration tests run against a real PostgreSQL. Inventory and money bugs live in
transactions, row locks and constraints; a mock would agree with whatever the
code does and prove nothing.
