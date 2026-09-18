import { z } from 'zod'
import { positiveMoney } from './catalog'
import { m } from '@/server/domain/money'

/**
 * The envelope every queued mutation travels in (docs/05 §3).
 *
 * Deliberately thin. The payload is validated by the same schema the Server
 * Action uses — `checkoutSchema`, `recordPaymentSchema`, `stopOutcomeSchema` —
 * so a queued sale and a live one are checked by exactly one set of rules.
 *
 * What the envelope adds is only what a *queued* mutation needs and a live one
 * does not: when it happened, and what the runner was told at the time.
 */
export const queuedMutationSchema = z.object({
  /** The intent itself. Shape depends on the endpoint. */
  payload: z.unknown(),

  /**
   * When the runner actually did this, from the device clock.
   *
   * Recorded, never trusted: document dates and sequence come from the server.
   * It exists so support can see that a sale posted at 4pm was taken at 11am in
   * a dead zone, which is otherwise unknowable.
   */
  occurredAtClient: z.string().datetime().optional(),

  /**
   * The total the runner was shown when the cart was built.
   *
   * **Not authoritative and never used as a price.** The server re-prices from
   * its own catalogue; this is only so the answer can say "the total moved"
   * instead of silently charging a different number (docs/05 §3).
   */
  clientEstimate: positiveMoney.optional(),

  /** How many times the client has tried to send this. For support, not logic. */
  attempt: z.coerce.number().int().min(1).max(10_000).optional(),
})

export type QueuedMutation = z.infer<typeof queuedMutationSchema>

/**
 * Whether the server's figure differs from what the runner was shown.
 *
 * Compared as decimals, not as strings: "64.35" and "64.350" are the same
 * money, and reporting a re-price that did not happen would train a runner to
 * ignore the one that did.
 *
 * With no estimate there is nothing to compare, so nothing is claimed.
 */
export function repricedAgainst(estimate: string | undefined, actual: string): boolean {
  if (estimate === undefined) return false
  return !m(estimate).equals(m(actual))
}
