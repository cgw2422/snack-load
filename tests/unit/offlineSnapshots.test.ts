import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clear, put, SNAPSHOTS } from '@/lib/offline/db'
import { ageLabel, isStale } from '@/lib/offline/age'
import { hydrate } from '@/lib/offline/hydrate'
import { BALANCES, CATALOG, recall, remember, ROUTE_DAY } from '@/lib/offline/snapshots'

/**
 * Cached reads, and the rule they exist to keep: **a figure and its age always
 * travel together** (docs/05 §2). A stale balance shown as live is worse than
 * no balance, so every path that stores one stores when it was taken, and every
 * path that cannot say when refuses to store it at all.
 */

beforeEach(async () => {
  await clear(SNAPSHOTS)
})

function server(answers: Record<string, { status: number; body?: unknown }>) {
  const calls: string[] = []
  const impl = (async (url: string | URL | Request) => {
    const path = String(url)
    calls.push(path)
    const answer = answers[path]
    if (!answer) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const OK = (asOf: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { asOf, ...extra },
})

const ALL = (asOf: string) => ({
  '/api/v1/snapshot/route-day': OK(asOf, { route: null }),
  '/api/v1/snapshot/catalog': OK(asOf, { items: [] }),
  '/api/v1/snapshot/balances': OK(asOf, { balances: [] }),
})

describe('how old a cached figure is', () => {
  it('reads the age off the device clock, not the server timestamp', () => {
    const now = Date.parse('2026-09-18T12:00:00Z')

    // A phone an hour behind. The server said 11:20; the copy was taken four
    // minutes ago by this device's own reckoning, and four minutes is the
    // truth the runner needs.
    const snapshot = { storedAt: now - 4 * 60_000, asOf: '2026-09-18T11:20:00Z' }
    expect(ageLabel(snapshot, now)).toBe('as of 4 min ago')
  })

  it('never reports a figure as arriving from the future', () => {
    const now = Date.parse('2026-09-18T12:00:00Z')
    expect(ageLabel({ storedAt: now + 90_000 }, now)).toBe('as of a moment ago')
  })

  it('counts a truck balance stale in minutes, not hours', () => {
    const now = Date.now()
    expect(isStale({ storedAt: now - 5 * 60_000 }, undefined, now)).toBe(false)
    expect(isStale({ storedAt: now - 20 * 60_000 }, undefined, now)).toBe(true)
  })
})

describe('refreshing what the device holds', () => {
  it('takes all three reads when there is nothing stored', async () => {
    const net = server(ALL('2026-09-18T12:00:00Z'))
    await hydrate(net.impl)

    expect(net.calls).toHaveLength(3)
    expect((await recall(ROUTE_DAY))?.asOf).toBe('2026-09-18T12:00:00Z')
    expect((await recall(CATALOG))?.asOf).toBe('2026-09-18T12:00:00Z')
    expect((await recall(BALANCES))?.asOf).toBe('2026-09-18T12:00:00Z')
  })

  it('asks again for balances long before it asks again for the catalogue', async () => {
    await remember(ROUTE_DAY, { asOf: 'a' })
    await remember(CATALOG, { asOf: 'a' })
    await remember(BALANCES, { asOf: 'a' })

    // Wind all three back three minutes. Quantities have moved with every sale
    // in that time; names and list prices have not.
    const aged = Date.now() - 3 * 60_000
    for (const key of [ROUTE_DAY, CATALOG, BALANCES]) {
      await put(SNAPSHOTS, { ...(await recall(key))!, storedAt: aged })
    }

    const net = server(ALL('2026-09-18T12:00:00Z'))
    await hydrate(net.impl)

    expect(net.calls).toEqual(['/api/v1/snapshot/balances'])
  })

  it('keeps the copy it has when the network is gone', async () => {
    await remember(ROUTE_DAY, { asOf: 'yesterday' })
    const net = server({})

    await hydrate(net.impl)

    expect((await recall(ROUTE_DAY))?.asOf).toBe('yesterday')
  })

  it('refuses to store an answer that cannot say when it was true', async () => {
    const net = server({
      '/api/v1/snapshot/route-day': { status: 200, body: { route: null } },
      '/api/v1/snapshot/catalog': { status: 200, body: { items: [] } },
      '/api/v1/snapshot/balances': { status: 200, body: { balances: [] } },
    })

    await hydrate(net.impl)

    // Nothing stored: a figure with no age is a figure the UI would have to
    // present as current, which is the one thing docs/05 §2 forbids.
    expect(await recall(ROUTE_DAY)).toBeUndefined()
    expect(await recall(BALANCES)).toBeUndefined()
  })
})
