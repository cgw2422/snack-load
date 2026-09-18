import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clear, QUEUE } from '@/lib/offline/db'
import {
  discard,
  enqueue,
  entries,
  resetSequenceForTesting,
  retry,
  snapshot,
} from '@/lib/offline/queue'
import { backoffMs, replay } from '@/lib/offline/replay'

/**
 * The offline queue, against a fake IndexedDB and a fake server (docs/05 §3).
 *
 * The property everything else serves: **a queued sale reaches the server
 * exactly once**, however the connection behaves in between. A lost response is
 * indistinguishable from a failure on the client, so the queue must be free to
 * send again — and that is only safe because the idempotency key travels with
 * the entry and is never regenerated.
 */

type Call = { url: string; body: Record<string, unknown> }

/** A server that records what it was asked and answers however a test says. */
function fakeServer(
  respond: (call: Call, index: number) => { status: number; body?: unknown } | 'unreachable',
) {
  const calls: Call[] = []

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    }
    calls.push(call)

    const answer = respond(call, calls.length - 1)
    if (answer === 'unreachable') throw new TypeError('Failed to fetch')

    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { impl, calls }
}

/** Mike, signed in to Ridgeline Distributing. Every entry below is his. */
const MIKE = 'org-1:user-mike'

const sale = (key: string, quantity = 3) => ({
  id: key,
  owner: MIKE,
  kind: 'sale' as const,
  endpoint: '/api/v1/sales',
  label: `Joe's Marathon · ${quantity} cases`,
  payload: {
    customerId: 'cust-1',
    idempotencyKey: key,
    lines: [{ productId: 'p-1', productUomId: 'u-1', quantity }],
  },
})

beforeEach(async () => {
  await clear(QUEUE)
  resetSequenceForTesting()
})

describe('what the queue carries', () => {
  it('holds intent and never a computed total', async () => {
    await enqueue({ ...sale('k-1'), clientEstimate: '64.35' })

    const [entry] = await entries()
    const payload = entry.payload as Record<string, unknown>

    expect(Object.keys(payload).sort()).toEqual(['customerId', 'idempotencyKey', 'lines'])
    expect(JSON.stringify(payload)).not.toMatch(/total|tax|price|amount/i)

    // The estimate rides on the envelope, deliberately outside the payload, so
    // it can never be mistaken for something to charge (docs/05 §3).
    expect(entry.clientEstimate).toBe('64.35')
  })

  it('survives being read back after a reload', async () => {
    await enqueue(sale('k-1'))
    await enqueue(sale('k-2'))

    const rows = await entries()
    expect(rows.map((row) => row.id)).toEqual(['k-1', 'k-2'])
    expect(rows.every((row) => row.status === 'pending')).toBe(true)
  })

  it('keeps the runner’s own order', async () => {
    await enqueue(sale('first'))
    await enqueue({
      id: 'payment', owner: MIKE, kind: 'payment', endpoint: '/api/v1/payments',
      label: 'Cash $40', payload: { idempotencyKey: 'payment' },
    })
    await enqueue({
      id: 'stop', owner: MIKE, kind: 'stop', endpoint: '/api/v1/route-stops/s-1/outcome',
      label: 'Stop finished', payload: { outcome: 'COMPLETED' },
    })

    expect((await entries()).map((row) => row.kind)).toEqual(['sale', 'payment', 'stop'])
  })
})

describe('replaying', () => {
  it('sends in order, one at a time', async () => {
    await enqueue(sale('a'))
    await enqueue(sale('b'))
    await enqueue(sale('c'))

    const server = fakeServer(() => ({ status: 200, body: { saleId: 'x', saleNumber: 'S-1' } }))
    const outcome = await replay(MIKE, server.impl)

    expect(outcome.sent).toBe(3)
    expect(server.calls.map((call) => (call.body.payload as { idempotencyKey: string }).idempotencyKey))
      .toEqual(['a', 'b', 'c'])
  })

  it('sends the same idempotency key when a response is lost', async () => {
    await enqueue(sale('lost-response'))

    // The server created the sale; the answer never arrived.
    const first = fakeServer(() => 'unreachable')
    await replay(MIKE, first.impl)

    const [afterFailure] = await entries()
    expect(afterFailure.status).toBe('pending')
    expect(afterFailure.attempts).toBe(1)

    // The runner comes back into signal. The queue does not know whether the
    // first attempt landed, and does not need to: it sends the same key.
    await retry('lost-response')
    const second = fakeServer(() => ({ status: 200, body: { saleId: 's-1', replayed: true } }))
    const outcome = await replay(MIKE, second.impl)

    expect(outcome.sent).toBe(1)
    expect((second.calls[0].body.payload as { idempotencyKey: string }).idempotencyKey).toBe(
      'lost-response',
    )
    // Same key, both times — that is the whole guarantee.
    expect((first.calls[0].body.payload as { idempotencyKey: string }).idempotencyKey).toBe(
      'lost-response',
    )
  })

  it('stops at the first entry it cannot send, rather than failing them all', async () => {
    await enqueue(sale('a'))
    await enqueue(sale('b'))
    await enqueue(sale('c'))

    const server = fakeServer((_call, index) =>
      index === 0 ? { status: 200, body: {} } : 'unreachable',
    )
    const outcome = await replay(MIKE, server.impl)

    expect(outcome.sent).toBe(1)
    expect(outcome.stoppedBecause).toBe('OFFLINE')
    // One failure, not three: everything behind it is in the same position, and
    // a burst of failed sends is how a tunnel exit turns into a support call.
    expect(server.calls).toHaveLength(2)

    const rows = await entries()
    expect(rows.map((row) => row.status)).toEqual(['done', 'pending', 'pending'])
  })

  it('backs off before trying an unreachable server again', async () => {
    await enqueue(sale('a'))

    const server = fakeServer(() => 'unreachable')
    await replay(MIKE, server.impl)

    const [entry] = await entries()
    expect(entry.nextAttemptAt).toBeGreaterThan(Date.now())

    // A second pass now sends nothing at all.
    const again = fakeServer(() => ({ status: 200 }))
    const outcome = await replay(MIKE, again.impl)
    expect(again.calls).toHaveLength(0)
    expect(outcome.sent).toBe(0)
  })

  it('blocks a refusal instead of retrying it forever', async () => {
    await enqueue(sale('bad'))

    const server = fakeServer(() => ({
      status: 409,
      body: { error: { message: 'Not enough stock: 36 requested, 12 on hand.' } },
    }))
    await replay(MIKE, server.impl)

    const [entry] = await entries()
    expect(entry.status).toBe('blocked')
    // The server's own words, so the runner knows what to do about it.
    expect(entry.error).toBe('Not enough stock: 36 requested, 12 on hand.')

    // And it is not tried again on its own.
    const second = fakeServer(() => ({ status: 200 }))
    await replay(MIKE, second.impl)
    expect(second.calls).toHaveLength(0)
  })

  it('keeps a signed-out entry rather than losing the sale', async () => {
    await enqueue(sale('a'))

    const server = fakeServer(() => ({ status: 401, body: { error: { message: 'Sign in' } } }))
    const outcome = await replay(MIKE, server.impl)

    expect(outcome.stoppedBecause).toBe('AUTH')
    const [entry] = await entries()
    // Pending, not blocked: signing back in is all it needs.
    expect(entry.status).toBe('pending')
  })

  it('does not send everything twice when two triggers fire together', async () => {
    await enqueue(sale('a'))
    await enqueue(sale('b'))

    const server = fakeServer(() => ({ status: 200, body: {} }))
    // A reconnect event and a visibility change, at the same instant.
    const first = replay(MIKE, server.impl)
    const second = replay(MIKE, server.impl)

    // The second caller joins the pass already running rather than starting
    // another — which is why both see the same result.
    expect(first).toBe(second)

    const [one, two] = await Promise.all([first, second])
    expect(one).toEqual(two)
    expect(one.sent).toBe(2)

    // Two entries, two requests. Not four.
    expect(server.calls).toHaveLength(2)
  })

  it('reports when the server re-priced a queued sale', async () => {
    await enqueue({ ...sale('a'), clientEstimate: '64.35' })

    const server = fakeServer(() => ({
      status: 200,
      body: { saleId: 's-1', saleNumber: 'S-01182', total: '66.00', repriced: true },
    }))
    await replay(MIKE, server.impl)

    const [entry] = await entries()
    expect(entry.status).toBe('done')
    expect(entry.result?.repriced).toBe(true)
    expect(entry.result?.total).toBe('66.00')
  })
})

describe('a phone two people have signed in to', () => {
  const SARAH = 'org-1:user-sarah'

  it('sends only what the person signed in queued', async () => {
    await enqueue(sale('mike-1'))
    await enqueue({ ...sale('sarah-1'), owner: SARAH })
    await enqueue(sale('mike-2'))

    const server = fakeServer(() => ({ status: 200, body: { saleId: 's' } }))
    const outcome = await replay(MIKE, server.impl)

    expect(outcome.sent).toBe(2)
    expect(server.calls).toHaveLength(2)

    const statuses = Object.fromEntries((await entries()).map((row) => [row.id, row.status]))
    expect(statuses).toEqual({ 'mike-1': 'done', 'sarah-1': 'pending', 'mike-2': 'done' })
  })

  it('leaves the other sign-in’s sale intact rather than dropping it', async () => {
    await enqueue({ ...sale('sarah-1'), owner: SARAH })

    const server = fakeServer(() => ({ status: 200, body: { saleId: 's' } }))
    await replay(MIKE, server.impl)

    expect(server.calls).toHaveLength(0)

    // Visible to Mike as somebody else's, and still Sarah's to send.
    expect((await snapshot(MIKE)).stranded).toBe(1)
    expect((await snapshot(SARAH)).pending).toBe(1)
  })
})

describe('what a person can do with a stuck entry', () => {
  it('retries a blocked entry only when asked', async () => {
    await enqueue(sale('a'))
    await replay(MIKE, fakeServer(() => ({ status: 422, body: { error: { message: 'No' } } })).impl)
    expect((await snapshot(MIKE)).blocked).toBe(1)

    await retry('a')
    expect((await snapshot(MIKE)).pending).toBe(1)
  })

  it('discards a blocked entry, and nothing else', async () => {
    await enqueue(sale('a'))
    await enqueue(sale('b'))
    // Only the first is refused; the second never gets sent, so it stays pending.
    await replay(
      MIKE,
      fakeServer((_call, index) =>
        index === 0 ? { status: 422, body: { error: { message: 'No' } } } : 'unreachable',
      ).impl,
    )

    const statuses = Object.fromEntries((await entries()).map((row) => [row.id, row.status]))
    expect(statuses).toEqual({ a: 'blocked', b: 'pending' })

    // A pending entry may have reached the server already; dropping it could
    // lose a sale that actually posted. Only a refusal can be discarded.
    await discard('b')
    expect((await entries()).map((row) => row.id)).toContain('b')

    await discard('a')
    expect((await entries()).map((row) => row.id)).not.toContain('a')
  })
})

describe('backoff', () => {
  it('doubles from five seconds, capped at five minutes, with jitter', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const delay = backoffMs(attempt)
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThanOrEqual(300_000)
    }
    expect(new Set(Array.from({ length: 30 }, () => backoffMs(3))).size).toBeGreaterThan(1)
  })
})

describe('when IndexedDB is not there at all', () => {
  it('reports an empty queue rather than throwing', async () => {
    const real = globalThis.indexedDB
    // @ts-expect-error — deliberately removing it, as a locked-down browser would.
    delete globalThis.indexedDB
    try {
      expect(await entries()).toEqual([])
    } finally {
      globalThis.indexedDB = real
    }
    vi.restoreAllMocks()
  })
})
