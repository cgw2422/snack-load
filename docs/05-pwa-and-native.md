# SnackLoad — PWA, Offline Resilience & the Future Native App

---

## 1. Mobile is the product, not a breakpoint

The runner screens are designed at 390 × 844 first and only then allowed to grow.
Concretely:

- Bottom navigation with five targets — **HOME · ROUTES · SELL · INVENTORY · MORE** —
  with SELL as a raised centre action.
- Every primary control sits in the lower two-thirds of the screen, reachable with
  a thumb. Destructive controls are deliberately placed out of that zone.
- Minimum touch target 44 × 44 px; primary route-runner actions are 56 px tall.
- `env(safe-area-inset-*)` respected on notched devices; the nav bar reserves
  `safe-area-inset-bottom`.
- Numeric fields use `inputMode="numeric"`; quantity is changed with −/+ steppers,
  not a keyboard. Search fields autofocus only on desktop.
- Sticky order totals so the total never scrolls out of view while adding lines.
- A 100 ms-budget optimistic UI on quantity steppers; the server remains authoritative.

Desktop is a genuinely different layout — a sidebar, dense tables, multi-column
forms — for imports, reports, and administration. It is not the phone layout
stretched, and the phone layout is not the desktop one squeezed.

## 2. PWA

- `app/manifest.ts` → name, short name `SnackLoad`, `display: standalone`,
  navy `theme_color`, maskable icons at 192/512, `orientation: portrait`.
- iOS: `apple-touch-icon`, `apple-mobile-web-app-capable`, status bar style, and
  generated splash metadata — iOS ignores much of the manifest.
- Installable on iOS home screen, Android, and desktop.
- A service worker (`public/sw.js`) with deliberately different strategies per
  asset class:

| Asset | Request | Strategy | Cache |
|---|---|---|---|
| App shell, JS, CSS, fonts, icons | `/_next/static/**`, `/icons/**`, `/brand/**` | cache-first, never revalidated | `snackload-shell-<build id>` |
| Today's route + its stops + those customers | `GET /api/v1/snapshot/route-day` | stale-while-revalidate | `snackload-data-<build id>-<org:user>` |
| Product catalog subset present on the truck | `GET /api/v1/snapshot/catalog` | stale-while-revalidate | same |
| Truck inventory balances | `GET /api/v1/snapshot/balances` | network-first, cached fallback | same |
| Anything else under `/api` | — | network only | — |
| A navigation that cannot reach the origin | — | the static `/offline` document | `snackload-fallback-<build id>` |
| Every mutation | any non-GET | **never cached, never retried here** | — |

Four properties of that table are load-bearing:

1. **The build id is in every cache name.** It comes from the commit (or the
   platform's build variable) via `generateBuildId`, reaches the client as
   `NEXT_PUBLIC_BUILD_ID`, and is passed to the worker as `/sw.js?v=<id>`. The
   `activate` handler deletes every cache that does not carry the current one,
   so a deploy cannot leave a runner on last week's JavaScript.
2. **Tenant reads are cached under the signed-in user.** The worker cannot read
   the httpOnly session cookie, so every page posts `{type:'IDENTITY', owner}`
   as it loads; the signed-out screens post `{type:'SIGN_OUT'}`. Either one
   deletes every data cache that is not the current owner's. Until a page has
   said who is signed in, nothing tenant-scoped is cached or served at all.
3. **No HTML is cached.** A document carries one organization's data and the
   worker has no way to tell two apart. `/offline` is the single exception, and
   it is static: everything on it is read from this device's own IndexedDB.
4. **Mutations do not go through the worker.** Only GET is handled. Replay is
   the queue's job, because the queue carries the idempotency key that makes a
   retry safe; a service worker replaying a POST it kept has no such key.

Cached financial figures are always labelled with their age, measured from the
device's own clock at the moment it took the copy rather than from the server's
timestamp — a phone with a wrong clock would otherwise report a figure taken
thirty seconds ago as four hours old. A stale balance presented as live is worse
than no balance.

## 2a. The performance budget, measured

The exit criterion is "usable on a mid-tier Android over 3G", which is a claim
about a device nobody on this project is holding — so it is emulated and
measured rather than asserted. `pnpm measure:3g` runs Chrome's own 3G profiles
with the CPU slowed fourfold, against a production build and the demo seed.

Two moments, because they are what a runner actually experiences: **tappable**
is the server-rendered list on screen and ready for a thumb, before any
JavaScript has run; **loaded** is everything arrived and hydrated.

| Profile | First paint | Tappable | Loaded | Over the wire |
|---|---|---|---|---|
| No throttling, cold | 112 ms | 161 ms | 205 ms | 251 KB |
| Fast 3G + 4× CPU, cold | 792 ms | 807 ms | 1.84 s | 250 KB |
| Fast 3G + 4× CPU, installed | 264 ms | 428 ms | 516 ms | **0 KB** |
| Slow 3G + 4× CPU, cold | 2.06 s | 2.14 s | 6.13 s | 250 KB |
| Slow 3G + 4× CPU, installed | 276 ms | 432 ms | 513 ms | **0 KB** |

The budget these numbers set, and what breaks it:

- **250 KB compressed for a cold load.** Adding a charting library or a second
  date library to a runner screen would blow it; both belong behind a dynamic
  import on the desktop reports instead.
- **Under 2 s to interactive on Fast 3G.** The cold Slow-3G figure of six
  seconds is the install cost and is paid once.
- **Zero bytes once installed, on any connection.** This is the whole point of
  the cache-first shell: the installed app is under 600 ms whether the link is
  fast, slow, or gone. If a change makes an installed load fetch anything on the
  critical path, the strategy table above is wrong and one of them has to give.

## 3. Offline posture

**Now (Phase 1 onward)**
- Cart drafts persist to IndexedDB on every change, keyed by the idempotency key
  minted at cart creation. A refresh, a crash, or a backgrounded tab loses nothing.
- Reads for the active route work offline from cache.
- Submitting while offline fails explicitly with a retry affordance — it does not
  pretend to succeed.

**Phase 9 (as built)**
- A durable mutation queue in IndexedDB (`src/lib/offline/`) replays sales,
  payments, and stop completions on reconnect, in order, with the stable
  idempotency key from `02 §I1`.
- The server stays the sole authority on price, stock, tax, and document numbers.
  A queued sale carries *intent* (customer, product, UoM, quantity), never computed
  money. It is re-priced on arrival, and the client is told if the total changed:
  the envelope's `clientEstimate` is compared with the server's figure and the
  response carries `repriced: true` when they differ.
- Replay is **single-flight, in sequence, one at a time, and stops at the first
  entry the network cannot carry** — everything behind it is in the same
  position, and hammering them produces a burst of failures the moment a tunnel
  ends. Backoff runs five seconds to five minutes, capped after jitter.
- A refusal (400, 403, 404, 409, 422) blocks the entry with the server's own
  words rather than being retried forever. A 401 leaves it pending: the entry
  keeps, and goes when somebody signs in again.
- **Queue entries are owned.** Each carries `organizationId:userId`. A drain
  sends only what the person currently signed in queued; anything left by an
  earlier sign-in on a shared phone stays exactly where it is, visible as
  stranded and intact, until its owner signs back in. Deleting it would drop a
  sale; sending it would post one runner's work under another's session.
- A pending entry can never be discarded by hand — only a blocked one. Something
  still pending may already have been accepted by a server whose answer was lost.
- Endpoints: `POST /api/v1/sales`, `/api/v1/payments`,
  `/api/v1/route-stops/{id}/outcome`. Each is the same auth, the same schema and
  the same service function as the Server Action behind the live screen, so a
  queued sale cannot behave differently from one taken with a signal.
- `completeStop` is replay-safe: the same outcome twice returns the same answer;
  a *different* outcome on a finished stop is a conflict, not an overwrite.

## 4. What the runner sees (Phase 9, as built)

Every screen that can be used without a signal says so, and says what it is
showing instead of the truth.

| Surface | Offline behaviour |
|---|---|
| Connection banner | `useOffline()` from `next/offline`, rendered in the app shell. Not a toast: losing signal is a condition that lasts, and it stays on screen. It reads the framework's detector rather than `navigator.onLine`, which calls a captive portal "online" — exactly what a store's guest WiFi is. |
| Queue tray | Appears only when something is waiting. Shows what is queued, what the office refused (with the server's own words), and what belongs to another sign-in on this phone. A refused entry can be retried or discarded; a *pending* one cannot be discarded at all. |
| Sell screen | Prices from the cached catalogue with `computeSaleTotals` — the same pure function the server prices with, so an estimate and the posted sale only ever differ because something really changed. The button says **Save on this phone**, the figure says **Estimated total**, and both carry the age of the prices behind them. A product this device has no cached price for blocks checkout by name rather than being silently left out of the total. |
| Stop screen | Queues the outcome under the stop's own id, so a second tap overwrites the pending entry instead of queueing a conflicting one. |
| Payment screen | Queues the amount taken. The balance on screen does not move: it is the server's figure and the payment has not reached it. |
| More screen | Explains how to install — Safari's share sheet on iOS, the browser menu elsewhere — and says why: a home-screen app gets its own storage, so the queue is not sharing a bucket Safari may evict. |

The offline estimate is the one place a client computes money, and it is fenced
in accordingly: it is never sent as a price, it rides on the queued entry only
as `clientEstimate`, and its sole job is to let the runner be told the total
moved rather than discover it on a statement.

What it cannot know, and does not pretend to: customer-specific and price-group
prices, a price changed in the office since the catalogue was cached, and stock
another runner has sold off the same truck. Offline, a stock shortfall warns but
does not block — `available` is as old as the cached balance snapshot, and the
server is the one that refuses, on arrival.

### Checking it stayed true

Two scripts, both against a production build and the demo seed, because the
service worker is deliberately not registered in development:

```bash
pnpm verify:offline   # 20 checks: cache, estimate, queue, replay, 320px, fallback
pnpm measure:3g       # the table above, re-measured
```

`verify:offline` drives the actual journey in Chromium — sign in, cache the day,
cut the connection, find a product from the cached list, save a sale on the
phone, reconnect, reload twice — and asserts what the phase exists to
guarantee: **one POST per queued sale, however many times it is replayed.**

**What we explicitly refuse to build:** an offline mode that assigns receipt
numbers locally or decrements stock client-side and merges later. That is how you
double-post a $500 sale, and it is unrecoverable once a customer has a printed
receipt.

## 5. Decisions made for the native app

| Decision | Why it matters later |
|---|---|
| Opaque bearer token, cookie is only a carrier | React Native stores the same token in Keychain/Keystore. No auth rewrite. |
| Versioned `/api/v1` calling the same services | The native app targets a contract that is already exercised in production by the web client. |
| DTOs are plain JSON; money is a string | No `Decimal`, `Date`, or Prisma type crosses the wire. Any client can consume it. |
| Pure `domain/` with zero Node imports | Can be bundled into React Native for optimistic totals and offline validation. |
| Idempotency keys on every financial write | Native's stronger offline queue is an additive feature, not a schema migration. |
| Barcode = a string field, scanning = a swappable adapter | Web uses `BarcodeDetector`/`getUserMedia`; native swaps in VisionCamera behind the same interface. |
| Receipts render from structured data | HTML for web/print/PDF, 80 mm-friendly layout now; a native Bluetooth ESC/POS driver reads the same receipt DTO. |
| Signature stored as PNG bytes from a canvas | Native swaps the capture surface; storage and rendering are unchanged. |
| Navigation via platform hand-off (`geo:` / Apple Maps URL) | Already the right behaviour; native just gets a nicer bridge. |
| Notifications behind a `notification.service` seam | Web push now, APNs/FCM later, same emit site. |

The backend and database do not change when the native app ships. That is the test
every architectural decision in this document had to pass.
