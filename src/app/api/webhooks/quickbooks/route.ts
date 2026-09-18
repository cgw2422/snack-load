import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '@/lib/env'
import { unsafeDb } from '@/server/db/client'

/**
 * QuickBooks webhook deliveries (docs/08 §12).
 *
 * What this endpoint does and, more importantly, what it does not:
 *
 *  - It **verifies the signature** before reading anything. Intuit signs the
 *    raw body with HMAC-SHA256 under the app's verifier token and sends the
 *    result base64 in `intuit-signature`. Without a configured verifier every
 *    request is refused rather than trusted.
 *  - It **records that something changed** and nothing more. A webhook never
 *    writes into SnackLoad's financial history: the direction of ownership is
 *    one-way (§11), and a notification is not evidence about our documents.
 *  - It answers quickly. Intuit retries a slow endpoint, and a retry storm is
 *    not a useful way to learn that somebody renamed a customer.
 *
 * The signature is computed over the **raw body text**, not over a re-stringified
 * object: `JSON.stringify` of a parsed payload drops whitespace and produces a
 * different hash, which is the usual reason a correct implementation fails.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const verifier = env().QUICKBOOKS_WEBHOOK_VERIFIER
  if (!verifier) {
    return NextResponse.json({ error: 'Webhooks are not configured.' }, { status: 503 })
  }

  const signature = request.headers.get('intuit-signature')
  if (!signature) return NextResponse.json({ error: 'Unsigned.' }, { status: 401 })

  const raw = await request.text()
  const expected = createHmac('sha256', verifier).update(raw, 'utf8').digest()
  const provided = Buffer.from(signature, 'base64')

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return NextResponse.json({ error: 'Bad signature.' }, { status: 401 })
  }

  let payload: {
    eventNotifications?: {
      realmId?: string
      dataChangeEvent?: { entities?: { name?: string; id?: string; operation?: string }[] }
    }[]
  }
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Unreadable payload.' }, { status: 400 })
  }

  for (const notification of payload.eventNotifications ?? []) {
    if (!notification.realmId) continue

    const connection = await unsafeDb.integrationConnection.findFirst({
      where: { provider: 'QUICKBOOKS_ONLINE', realmId: notification.realmId },
      select: { id: true, organizationId: true },
    })
    if (!connection) continue

    for (const entity of notification.dataChangeEvent?.entities ?? []) {
      if (!entity.name || !entity.id) continue

      const mapping = await unsafeDb.externalMapping.findFirst({
        where: {
          organizationId: connection.organizationId,
          provider: 'QUICKBOOKS_ONLINE',
          externalId: entity.id,
        },
        select: { id: true, entityType: true },
      })
      if (!mapping) continue

      /**
       * Flag it, do not act on it. A delete over there does not delete anything
       * here, and an edit over there does not become our figure — the operator
       * is told, and decides (§11).
       */
      const removed = entity.operation === 'Delete' || entity.operation === 'Void'
      await unsafeDb.externalMapping.update({
        where: { id: mapping.id },
        data: {
          status: 'NEEDS_ATTENTION',
          lastError: removed
            ? `The QuickBooks ${entity.name} for this document was ${String(entity.operation).toLowerCase()}ed there. SnackLoad has not changed anything.`
            : `The QuickBooks ${entity.name} for this document was edited in QuickBooks. SnackLoad has not overwritten it.`,
        },
      })
    }
  }

  return NextResponse.json({ ok: true })
}
