# SnackLoad — Authentication, Authorization & Security

---

## 1. Authentication

Email + password, with the password hashed using **scrypt** (Node's built-in
`crypto.scrypt`, N=16384, r=8, p=1, 16-byte random salt, 64-byte key, stored as
`scrypt$N$r$p$salt$hash`). The `passwordAlgo` column is versioned so we can move to
Argon2id later and re-hash on next successful login without a flag day.

Defences: constant-time comparison; a dummy hash verified on unknown emails so
timing does not reveal account existence; `failedLoginCount` + `lockedUntil`
exponential lockout; rate limiting by IP and by email.

## 2. Sessions — one token, two transports

This is the decision that makes a future native app possible without a rewrite.

```
login → 32 random bytes → base64url  = THE TOKEN (returned to the client once)
        sha256(token)                = stored in Session.tokenHash
```

The raw token is never persisted. Lookup is by hash.

| Client | Carries the token as |
|---|---|
| Web | `snackload_session` cookie — `httpOnly`, `secure`, `sameSite=lax`, `path=/` |
| Native / API | `Authorization: Bearer <token>` |

`resolveSession()` checks the header first, then the cookie. Both paths produce the
same `AuthContext`. Sessions expire after 30 days, sliding on use (at most one
`lastUsedAt` write per hour). Logout revokes the row; a password change revokes all
of a user's sessions.

Because web auth is a cookie, Server Actions and any non-idempotent REST route
verify **`Origin`/`Sec-Fetch-Site`** against the app origin for cookie-authenticated
requests. Bearer-authenticated requests are exempt (they cannot be forged by a
browser). That is our CSRF posture, plus `sameSite=lax`.

## 3. Permissions, not roles

Call sites always ask for a **permission string**. No service ever branches on a
role name.

```ts
requirePermission(ctx, 'inventory:adjust')
```

Namespaces and actions:

```
org:read  org:update  org:manage_integrations
user:read user:invite user:update user:deactivate role:manage
product:read product:create product:update product:deactivate product:import
price:read price:override
customer:read customer:create customer:update customer:deactivate customer:import
inventory:read inventory:receive inventory:adjust inventory:transfer
inventory:load_truck inventory:unload_truck
route:read route:read_own route:create route:update route:assign route:optimize
routerun:start routerun:complete routerun:closeout routerun:closeout_approve
sale:read sale:read_own sale:create sale:discount sale:void
payment:read payment:create payment:allocate payment:void
return:create return:approve
receipt:read receipt:send
report:read report:financial report:export
audit:read
```

### The `_own` scoping rule
`sale:read` sees every sale in the organization. `sale:read_own` sees only the
actor's. A runner holds `route:read_own` and `sale:read_own`; the service inspects
which of the pair is present and narrows the `where` clause accordingly. Scoping is
part of the query, never a filter applied after fetching.

### Role → permission bundles (seeded per organization)

| Role | Shape |
|---|---|
| **owner** | every permission, including `role:manage`, `org:manage_integrations`, `audit:read`. Cannot be removed from the last owner. |
| **admin** | everything except billing/ownership transfer. |
| **runner** | `route:read_own`, `routerun:*` (not `closeout_approve`), `sale:create`, `sale:read_own`, `payment:create`, `return:create`, `customer:read`, `customer:update` (notes only), `product:read`, `inventory:read` (own truck), `receipt:*`. |
| **warehouse** | `inventory:*`, `product:read/update`, `route:read`. No financial reads. |
| **office** | `customer:*`, `sale:read`, `payment:*`, `report:*`, `receipt:*`, `org:manage_integrations`. No inventory posting. |

Roles are **rows**, seeded at organization creation. A custom role in V2 is an
INSERT plus checkboxes — no code change, because nothing checks a role name.

## 4. Where checks happen

1. **Service layer (authoritative).** First lines of every mutating function.
2. **Route/layout guards.** `requireAuth()` in the authenticated layout; a
   permission-aware redirect keeps a runner out of `/settings`.
3. **UI affordances.** Hiding a button is courtesy, never a control. A `<Can>`
   helper reads the permission set from context.

## 5. Tenant isolation — defence in depth

**Layer 1 — schema.** `organizationId NOT NULL` on every tenant table, first
column of its primary index.

**Layer 2 — a scoped Prisma client.** App code imports `db(ctx)`, not the raw
client. A Prisma **client extension** intercepts every model operation:
- injects `organizationId: ctx.organizationId` into `where` on
  `findMany/findFirst/update/updateMany/delete/deleteMany/count/aggregate`,
- injects it into `data` on `create/createMany`,
- rewrites `findUnique` on tenant models into `findFirst` with the org predicate,
  so a leaked cuid from another tenant returns null,
- throws on `delete`/`deleteMany` for financial models (see `01 §9`).

The unscoped client is exported only as `unsafeDb` from a single file, used by
auth (pre-session), the seeder, and the sync worker, each of which sets its own
scope explicitly.

**Layer 3 — identifiers are never trusted.** `organizationId` is read from the
session. A body field named `organizationId` is stripped by the Zod schema.

**Layer 4 — tests.** `tests/integration/tenant-isolation.test.ts` creates two
organizations with identical-looking data and asserts every read path returns
nothing and every write path throws across the boundary.

**Layer 5 (planned hardening).** Postgres RLS with `SET LOCAL app.organization_id`
per transaction. The extension already funnels all access through one place, so
enabling RLS is additive.

## 6. Input, upload, and rate limits

- Every external input goes through Zod. Unknown keys are stripped, not passed through.
- Imports accept `.csv`, `.xlsx` only; content is sniffed, not trusted from the
  extension; hard caps on file size and row count; parsing happens off the request
  path; formulas are read as values (no CSV-injection on export either — leading
  `= + - @` are prefixed on export).
- Signature and image uploads are size-capped and re-encoded.
- Rate limits: login (per IP + per email), registration, import upload, report
  export, and all `/api/v1` traffic per session.

## 7. Secrets

- `SESSION_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, QuickBooks client
  credentials live in the server environment. None is prefixed `NEXT_PUBLIC_`.
- QuickBooks access/refresh tokens are sealed with **AES-256-GCM** using a key
  derived from `ENCRYPTION_KEY`, stored as `v1:iv:tag:ciphertext`. The key id
  prefix allows rotation. Tokens are decrypted only inside the integration service
  and never logged or returned by any API.
- Env is validated at boot by a Zod schema; the server refuses to start with a
  missing or weak secret in production.

## 8. Audit log

Written inside the same transaction as the change, so an audit entry cannot go
missing when a write succeeds.

Always audited: inventory adjustments and transfers, price changes, sale void,
payment void/reversal, customer balance adjustment, route reassignment, role and
permission changes, member deactivation, import commits, QuickBooks
connect/disconnect/mapping changes, and every settings change.

Each row keeps actor, timestamp, action, entity, and before/after JSON with
sensitive fields redacted.
