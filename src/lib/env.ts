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
