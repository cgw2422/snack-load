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
- A service worker with deliberately different strategies per asset class:

| Asset | Strategy |
|---|---|
| App shell, JS, CSS, fonts, icons | cache-first, versioned by build id |
| Today's route + its stops + those customers | stale-while-revalidate, refreshed on route start |
| Product catalog subset present on the truck | stale-while-revalidate |
| Truck inventory balances | network-first, cached fallback, shown with an "as of" timestamp |
| Every mutation | **never cached** — queued (Phase 9) or failed loudly |

Cached financial figures are always labelled with their age. A stale balance
presented as live is worse than no balance.

## 3. Offline posture

**Now (Phase 1 onward)**
- Cart drafts persist to IndexedDB on every change, keyed by the idempotency key
  minted at cart creation. A refresh, a crash, or a backgrounded tab loses nothing.
- Reads for the active route work offline from cache.
- Submitting while offline fails explicitly with a retry affordance — it does not
  pretend to succeed.

**Phase 9**
- A durable mutation queue replays sales, payments, and stop completions on
  reconnect, in order, with the stable idempotency key from `02 §I1`.
- The server stays the sole authority on price, stock, tax, and document numbers.
  A queued sale carries *intent* (customer, product, UoM, quantity), never computed
  money. It is re-priced on arrival, and the client is told if the total changed.

**What we explicitly refuse to build:** an offline mode that assigns receipt
numbers locally or decrements stock client-side and merges later. That is how you
double-post a $500 sale, and it is unrecoverable once a customer has a printed
receipt.

## 4. Decisions made for the native app

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
