import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '@/lib/env'
import { sweep } from '@/server/integrations/quickbooks/sync/scheduler'

/**
 * The cron entry point (docs/08 §19).
 *
 * Chosen over a separate worker process because this deployment is a single
 * Next.js service: a second process would need its own build, its own release
 * and its own way of going stale, to run code that already exists here. A
 * scheduled HTTP call to an authenticated internal route reuses the deployment
 * that is already running and already has the database and the secrets.
 *
 * What makes it safe:
 *
 *  - **A shared secret**, compared in constant time. Without `SYNC_WORKER_TOKEN`
 *    configured the route refuses every request rather than running unguarded.
 *  - **No session, no tenant, no user input that selects work.** It sweeps the
 *    connected organizations and nothing else; there is no parameter that could
 *    be turned into an authorization bypass.
 *  - **Nothing here is administration.** It cannot connect, disconnect, remap or
 *    change settings. The worst a leaked token buys is making the sync run.
 *  - **Idempotent by construction.** Two overlapping invocations lease jobs
 *    separately and never process the same one (§20).
 */

function authorized(request: NextRequest): boolean {
  const expected = env().SYNC_WORKER_TOKEN
  if (!expected) return false

  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : header

  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function run(request: NextRequest): Promise<NextResponse> {
  if (!env().SYNC_WORKER_TOKEN) {
    return NextResponse.json(
      { error: 'The sync worker is not configured on this server.' },
      { status: 503 },
    )
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const perOrganization = Number(request.nextUrl.searchParams.get('limit') ?? '100')
  const result = await sweep({
    perOrganization: Number.isFinite(perOrganization)
      ? Math.max(1, Math.min(500, perOrganization))
      : 100,
  })

  // A summary, not the documents: this response can end up in a cron provider's
  // logs, and customer names and amounts do not belong there.
  return NextResponse.json({
    workerId: result.workerId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    organizations: result.organizations.length,
    ...result.totals,
  })
}

/** POST is the real verb. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return run(request)
}

/**
 * GET as well, because several hosted cron providers — Railway's included —
 * only issue GETs. It carries the same token and does the same work; refusing
 * it would mean an operator wiring up something more fragile instead.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return run(request)
}
