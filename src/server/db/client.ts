import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'
import { env } from '@/lib/env'

/**
 * The UNSCOPED client. Importing this bypasses tenant isolation, so it is only
 * legitimate in three places (docs/04 §5):
 *
 *   1. authentication, which runs before an organization is known,
 *   2. the seeder, which creates organizations,
 *   3. the background sync worker, which sets its own scope per job.
 *
 * Everything else must use `db(ctx)` from './tenant'.
 */
function create(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env().DATABASE_URL })
  return new PrismaClient({
    adapter,
    log: env().NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

const globalForPrisma = globalThis as unknown as { unsafeDb?: PrismaClient }

export const unsafeDb: PrismaClient = globalForPrisma.unsafeDb ?? create()

// Next.js dev server hot-reloads modules; without this each reload opens a new pool.
if (env().NODE_ENV !== 'production') globalForPrisma.unsafeDb = unsafeDb
