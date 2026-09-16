import { config } from 'dotenv'

// Loaded before any test module imports the Prisma client or reads env().
config({ path: '.env.test', override: true })
