import { execSync } from 'node:child_process'
import { config } from 'dotenv'

/**
 * Integration tests run against a real Postgres, not a mock. Inventory and money
 * bugs live in transactions, row locks and constraints — a fake would agree with
 * whatever the code does and prove nothing.
 */
export default async function setup() {
  config({ path: '.env.test', override: true })

  const url = process.env.DATABASE_URL
  if (!url) throw new Error('Set DATABASE_URL in .env.test before running the tests.')
  if (!/test/i.test(url)) {
    throw new Error(`Refusing to run tests against a database that is not named for testing: ${url}`)
  }

  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  })
}
