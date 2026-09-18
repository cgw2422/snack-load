
/**
 * SnackLoad's service worker (docs/05 §2).
 *
 * Its job is narrow and its refusals matter more than its caching:
 *
 *  - **No mutation is ever cached, served from cache, or retried here.** Only
 *    GET is handled at all; everything else falls straight through to the
 *    network. Replay belongs to the durable queue in `src/lib/offline`, which
 *    carries the idempotency key that makes a retry safe. A service worker
 *    replaying a POST it kept has no such key and no such guarantee.
 *  - **No tenant data outlives its session.** Snapshot reads are kept in a
 *    cache named for the signed-in user and emptied the moment anybody else —
 *    or nobody — is signed in on this device.
 *  - **No HTML is cached.** A document carries one organization's data, and
 *    this worker cannot read the session cookie to tell two of them apart. When
 *    a navigation cannot reach the network it gets `/offline`, which is static
 *    and renders from what the client already holds.
 *
 * The version comes from the registration URL (`/sw.js?v=<build id>`), so a
 * deploy produces a new worker and a new set of cache names, and `activate`
 * deletes everything belonging to the build before it.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'

/** Immutable, content-hashed build output plus the icons. Cache-first. */
const SHELL = `snackload-shell-${VERSION}`
/** The static offline document. Precached; it is the only HTML kept. */
const FALLBACK = `snackload-fallback-${VERSION}`
/** Tenant reads. Suffixed with the signed-in user; see `dataCacheName`. */
const DATA_PREFIX = `snackload-data-${VERSION}-`

const OFFLINE_URL = '/offline'

/**
 * Who the open tabs say is signed in, as `organizationId:userId`.
 *
 * The worker cannot read the httpOnly session cookie, so identity arrives by
 * `postMessage` from every page as it loads. Until a page says otherwise, no
 * tenant read is cached or served: guessing wrong here means showing one
 * distributor another one's route.
 */
let identity = null

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(FALLBACK)
      await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }))
      // A runner who force-quits and reopens in a dead zone should get the new
      // worker, not the one from three deploys ago waiting for every tab to close.
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((name) => name.startsWith('snackload-') && !name.includes(`-${VERSION}`))
          .map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  const message = event.data
  if (!message || typeof message !== 'object') return

  if (message.type === 'IDENTITY') {
    const next = typeof message.owner === 'string' && message.owner ? message.owner : null
    if (next !== identity) {
      identity = next
      // Somebody else is at the wheel, or nobody is. Whatever the last session
      // cached is not theirs to see.
      event.waitUntil(dropOtherDataCaches(next))
    }
  }

  if (message.type === 'SIGN_OUT') {
    identity = null
    event.waitUntil(dropOtherDataCaches(null))
  }
})

async function dropOtherDataCaches(owner) {
  const keep = owner === null ? null : dataCacheName(owner)
  const names = await caches.keys()
  await Promise.all(
    names
      .filter((name) => name.startsWith('snackload-data-') && name !== keep)
      .map((name) => caches.delete(name)),
  )
}

function dataCacheName(owner) {
  return `${DATA_PREFIX}${owner}`
}

/** Build output and icons: content-hashed or versioned, so never revalidated. */
function isShellAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/brand/') ||
    url.pathname === '/favicon.ico' ||
    url.pathname === '/manifest.webmanifest'
  )
}

/**
 * Reads the phone may keep, and how long each stays believable.
 *
 * `swr` serves the cached copy immediately and refreshes behind it; `network`
 * tries the server first and only falls back when it cannot be reached. The
 * split is not arbitrary — see the table in `offline.service.ts`.
 */
const SNAPSHOT_STRATEGY = {
  '/api/v1/snapshot/route-day': 'swr',
  '/api/v1/snapshot/catalog': 'swr',
  '/api/v1/snapshot/balances': 'network',
}

self.addEventListener('fetch', (event) => {
  const request = event.request

  // Everything that changes something on the server goes straight through. No
  // cache lookup, no cache write, no background retry.
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // A partial response is not a cacheable one, and storing it would serve a
  // truncated PDF on the next request.
  if (request.headers.has('range')) return

  if (isShellAsset(url)) {
    event.respondWith(cacheFirst(request, SHELL))
    return
  }

  const strategy = SNAPSHOT_STRATEGY[url.pathname]
  if (strategy === 'swr') {
    // `waitUntil` has to be called synchronously, while the event is still
    // being dispatched, or it throws. So the served response and the background
    // refresh are two handles on one pass, taken here rather than inside it.
    const pass = staleWhileRevalidate(request)
    event.respondWith(pass.then((outcome) => outcome.response))
    event.waitUntil(pass.then((outcome) => outcome.refreshed))
    return
  }
  if (strategy === 'network') {
    event.respondWith(networkFirst(request))
    return
  }

  // Everything else under /api/v1 — receipts, exports, product search — is
  // either a document that must be current or a search that is meaningless
  // stale. Network only.
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(navigateOrOffline(request))
  }
})

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit) return hit

  const response = await fetch(request)
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone())
  return response
}

/**
 * The cached copy now, a fresh one for next time.
 *
 * Returns both halves. The response is what the page gets — immediately, if
 * there is a cached copy. `refreshed` is the write behind it, which the fetch
 * handler hands to `waitUntil` so the worker is not killed mid-write and left
 * with a half-updated entry.
 */
async function staleWhileRevalidate(request) {
  const cache = await openDataCache()
  if (!cache) return { response: await fetch(request), refreshed: null }

  const hit = await cache.match(request)
  const fresh = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone())
      return response
    })
    .catch(() => null)

  if (hit) return { response: hit, refreshed: fresh }

  const response = (await fresh) ?? Response.json({ error: { code: 'OFFLINE' } }, { status: 503 })
  return { response, refreshed: null }
}

async function networkFirst(request) {
  const cache = await openDataCache()

  try {
    const response = await fetch(request)
    if (response.ok && cache) await cache.put(request, response.clone())
    return response
  } catch {
    const hit = cache ? await cache.match(request) : undefined
    if (hit) return hit
    return Response.json({ error: { code: 'OFFLINE' } }, { status: 503 })
  }
}

/**
 * The tenant read cache, or nothing.
 *
 * Returning `null` before a page has told the worker who is signed in is the
 * safe default: the read still goes to the network, and the only thing lost is
 * a cache hit on the very first load after a cold start.
 */
async function openDataCache() {
  if (!identity) return null
  return caches.open(dataCacheName(identity))
}

async function navigateOrOffline(request) {
  try {
    return await fetch(request)
  } catch {
    const cache = await caches.open(FALLBACK)
    const offline = await cache.match(OFFLINE_URL)
    return (
      offline ??
      new Response('<h1>Offline</h1>', {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    )
  }
}
