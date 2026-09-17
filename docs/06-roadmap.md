# SnackLoad — Implementation Phases

Deliberately sequenced. Each phase ends with something a distributor could use and
with tests around its financial or inventory invariants.

| Phase | Scope | Exit criteria |
|---|---|---|
| **1 — Foundation** | Project setup, design system, Prisma schema + migration for the whole model, auth (register org, login, sessions, invitations), users/roles/permissions, tenant-scoped DB client, responsive app shell + mobile bottom nav, dashboard skeleton, onboarding checklist, PWA manifest + icons, demo seed. | Two orgs can register; a runner and an owner see different navigation; tenant-isolation and permission tests pass; demo org seeds realistic data. |
| **2 — Products & Stores** | Product CRUD + UoMs + categories + suppliers, customer accounts + contacts, price groups and customer prices, CSV/XLSX import for both with mapping/preview/update-mode, bulk account actions. | An unmodified distributor spreadsheet imports cleanly; re-importing updates instead of duplicating. |
| **3 — Inventory** | Warehouses, vehicles, ledger posting engine, balances, receiving, adjustments, transfers, truck load/unload, suggested load. | `SUM(ledger) == balance` holds under concurrent posting; negative-stock policy enforced. |
| **4 — Routes** | Route templates, recurring customer schedules, route builder, geographic optimization, drag-to-reorder, map view, multi-runner assignment and reassignment, the runner stop workflow. | Tuesday's due accounts build a route; Mike's stops move to Sarah with history intact. |
| **5 — Sales** | Product search + barcode, cart with UoM steppers, pricing resolution, tax, discounts, checkout, inventory deduction, idempotent submit. | Totals identity holds; a replayed submit bills once. |
| **6 — Receipts & AR** | Receipt documents, signature capture, PDF, email/text/share, print + 80 mm layouts, AR balances, payment recording and allocation, returns and credit memos, aging. | A $500 sale paid $200 shows $300; oldest-first allocation matches the hand-worked example. |
| **7 — Reports** | Owner and runner dashboards, sales, profitability, customer (incl. declining accounts), inventory, route, runner, AR aging, with PDF/CSV/Excel export. | Every report filterable by date/route/runner/customer/product and exportable. |
| **7.5 — Returns & credits** | Customer returns with per-line disposition, credit memos with snapshotted lines, refunds as their own document, unapplied customer credit, credit allocation, void ordering, credit-memo documents on the Phase 6 stack, the account timeline, and gross/returns/net reporting. | A $20 sale costing $12, fully returned, moves gross profit by −$8 at the ORIGINAL cost; a damaged return never re-enters sellable stock; over-returning is refused server-side. |
| **8 — QuickBooks** | OAuth connect, entity mapping, outbox + sync worker, retries and backoff, sync logs, error UI, manual and auto sync. | Intuit outage never blocks a sale; failed jobs retry and surface. |
| **9 — PWA & resilience** | Installability polish, caching strategies, offline route reads, durable mutation queue, performance budget work. | Runner workflow usable on a mid-tier Android over 3G; queued sales replay without double-posting. |

**Standing rule:** nothing in a later phase may require reshaping the schema or the
service contracts established in Phase 1. Where a later capability needs a column,
that column exists now (idempotency keys, `unitCostAtSale`, `ExternalMapping`,
`OutboxEvent`), even if nothing writes to it yet.
