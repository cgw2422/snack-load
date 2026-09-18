import { z } from 'zod'

/**
 * Environment is validated once, at boot. The server refuses to start rather
 * than discovering a missing secret at the moment it signs a session.
 * Nothing here is ever prefixed NEXT_PUBLIC_ (docs/04 §7).
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY must be at least 32 characters'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  // Messaging. Nothing names a vendor in code — the adapter is chosen here and
  // everything else talks to the interfaces in src/server/messaging (docs/03 §8).
  // With no URL configured the console provider runs, which production refuses.
  EMAIL_PROVIDER_NAME: z.string().default('http-email'),
  EMAIL_PROVIDER_URL: z.string().url().optional(),
  EMAIL_PROVIDER_TOKEN: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SMS_PROVIDER_NAME: z.string().default('http-sms'),
  SMS_PROVIDER_URL: z.string().url().optional(),
  SMS_PROVIDER_TOKEN: z.string().optional(),
  SMS_FROM: z.string().optional(),

  /**
   * How long a shared receipt link stays usable, in days. Long by default: a
   * store asking in December for last March's invoice is ordinary business, and
   * a link that has quietly died turns a two-second answer into a phone call.
   * Set to 0 for links that never expire.
   */
  RECEIPT_LINK_DAYS: z.coerce.number().int().min(0).default(400),

  // QuickBooks Online. Absent means the integration is simply unavailable —
  // the settings screen says so rather than offering a button that cannot work.
  // Nothing here is ever prefixed NEXT_PUBLIC_ (docs/04 §7).
  QUICKBOOKS_CLIENT_ID: z.string().optional(),
  QUICKBOOKS_CLIENT_SECRET: z.string().optional(),
  /**
   * The verifier token from the Intuit app dashboard, used to authenticate
   * webhook deliveries. Without it the webhook endpoint refuses every request
   * rather than trusting an unsigned one.
   */
  QUICKBOOKS_WEBHOOK_VERIFIER: z.string().optional(),
  /**
   * Which QuickBooks a NEW connection defaults to offering. Deliberately
   * `SANDBOX`: an operator has to choose production, and the choice is then
   * stored on the connection rather than re-read from here (docs/08 §3).
   */
  QUICKBOOKS_DEFAULT_ENVIRONMENT: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
  /**
   * Runs the integration against the in-memory fake instead of Intuit, so the
   * screens can be demonstrated and driven in a browser without an Intuit app.
   *
   * Refused outright in production (below). A silently faked accounting
   * integration is worse than no integration: the books look synced and are not.
   */
  QUICKBOOKS_USE_FAKE: z.coerce.boolean().default(false),
})

export type Env = z.infer<typeof schema>

function load(): Env {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${detail}`)
  }

  // A development placeholder must never reach production.
  if (parsed.data.NODE_ENV === 'production') {
    if (parsed.data.QUICKBOOKS_USE_FAKE) {
      throw new Error('QUICKBOOKS_USE_FAKE is set in production. Refusing to start.')
    }
    for (const key of ['SESSION_SECRET', 'ENCRYPTION_KEY'] as const) {
      if (parsed.data[key].startsWith('dev-only')) {
        throw new Error(`${key} still holds its development placeholder. Refusing to start.`)
      }
    }
  }
  return parsed.data
}

let cached: Env | undefined
export function env(): Env {
  cached ??= load()
  return cached
}
