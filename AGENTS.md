<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# SnackLoad

Route sales and distribution management for independent snack and beverage
distributors. Mobile-first, multi-tenant, built in phases.

## Read the design before changing anything

`docs/` holds the architectural contract, and the code is built to it:

| Document | Settles |
|---|---|
| `docs/00-architecture.md` | Layers, stack, and the ten risks that would sink this product |
| `docs/01-data-model.md` | The relational model and the decisions that shape it |
| `docs/02-inventory-and-money-rules.md` | **The invariants.** Money, units, the ledger, AR, idempotency |
| `docs/03-service-and-api-boundaries.md` | The service contract, both transports, imports, integrations |
| `docs/04-authorization.md` | Credentials, sessions, permissions, tenant isolation, secrets |
| `docs/05-pwa-and-native.md` | Mobile specifics, offline posture, native-app compatibility |
| `docs/06-roadmap.md` | Phases and their exit criteria |
| `docs/07-quickbooks-mapping.md` | The object mapping Phase 8 implements |
| `docs/08-quickbooks-integration.md` | **The integration as built.** OAuth, sync states, duplicates, tax, COGS, voids, split payments, the scheduled worker |

## Rules that are not negotiable

1. **Money is never a JavaScript `number`.** Postgres `numeric`, `decimal.js`,
   decimal strings on the wire. Rounding happens at the two boundaries named in
   `docs/02 §M2` and nowhere else.
2. **Quantities are integer base units.** `18 cases + 7 bags` is `223`.
   Packaging lives in `ProductUom`; splitting it back out is presentation only.
3. **Stock moves only through the ledger.** `postInventoryTransaction` is the
   single write path. Nothing else touches `inventory_balance`.
4. **Business logic lives in `src/server/services/**`,** takes an `AuthContext`
   first, returns plain JSON. Server Actions and `/api/v1` are two transports
   over the same functions — that is what lets a native app reuse this backend.
5. **App code uses `db(ctx)`, never `unsafeDb`.** The three legitimate
   exceptions are documented in `docs/04 §5`.
6. **Financial records are voided or reversed, never deleted.**
7. **A posted sale is history.** Returns and corrections create new documents
   that reference the original; they never edit or delete a sale line
   (`docs/02 §5b`).

## Working on this codebase

```bash
pnpm dev            # dev server (Turbopack; writes .next/dev/lock)
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest: unit + integration against a real Postgres
pnpm lint
pnpm db:migrate     # create and apply a migration
pnpm db:seed        # rebuild the demo organization
pnpm icons          # regenerate PWA icons from public/brand/icon.svg
```

- Integration tests need a database whose name contains `test`; the suite
  refuses to run against anything else.
- After adding or moving a route, run `pnpm exec next typegen` so
  `PageProps<'/route'>` and friends stay accurate.
- Verify UI changes in a browser, not only in tests. Chromium is at
  `/opt/pw-browsers/chromium`; check both a phone viewport and desktop, and
  assert no page scrolls sideways at 320px.
- A single `next dev` per project: `.next/dev/lock` records the running one.
