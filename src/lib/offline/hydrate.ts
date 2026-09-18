import { BALANCES, CATALOG, recall, remember, ROUTE_DAY } from './snapshots'

/**
 * Keeping this device's copy of the runner's day current (docs/05 §2).
 *
 * The service worker decides how a response is served; this decides how often
 * one is asked for, and it parses what comes back into the store the offline
 * screens read. The two are complementary — a cache hit the app never asks for
 * is a cache hit nobody sees.
 *
 * Refresh intervals are per read, and match how fast each one goes wrong:
 *
 *  - the stop list is settled at dispatch and changes rarely,
 *  - list prices change when somebody in the office changes them,
 *  - truck balances change with every sale the runner makes.
 *
 * Failure is silent by design. This runs on every page load, and a runner in a
 * dead zone does not need three error toasts telling them what they can see out
 * of the window.
 */

type Refresh = { key: string; url: string; maxAgeMs: number }

const READS: Refresh[] = [
  { key: ROUTE_DAY, url: '/api/v1/snapshot/route-day', maxAgeMs: 5 * 60_000 },
  { key: CATALOG, url: '/api/v1/snapshot/catalog', maxAgeMs: 30 * 60_000 },
  { key: BALANCES, url: '/api/v1/snapshot/balances', maxAgeMs: 2 * 60_000 },
]

export async function hydrate(fetchImpl: typeof fetch = fetch): Promise<void> {
  const now = Date.now()

  for (const read of READS) {
    const held = await recall<unknown>(read.key)
    if (held && now - held.storedAt < read.maxAgeMs) continue

    try {
      const response = await fetchImpl(read.url, { headers: { Accept: 'application/json' } })
      if (!response.ok) continue

      const body = (await response.json()) as { asOf?: unknown }
      // Without the server's timestamp there is no honest way to label the age
      // of what is in it, so it is not stored at all.
      if (typeof body.asOf !== 'string') continue

      await remember(read.key, body as { asOf: string })
    } catch {
      // No signal, or the read was refused. The held copy stays, with its age.
    }
  }
}
