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
