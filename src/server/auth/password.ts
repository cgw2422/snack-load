import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import type { ScryptOptions } from 'node:crypto'
import { promisify } from 'node:util'

// promisify() collapses scrypt's overloads and drops the options argument, which
// is exactly the argument that carries the cost parameters. Restore the signature.
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

/**
 * Password hashing (docs/04 §1).
 *
 * scrypt from Node's standard library: memory-hard, no native build step, and
 * available everywhere this will ever run. The stored string carries its own
 * parameters, and User.passwordAlgo is versioned, so moving to Argon2id later is
 * a re-hash on next successful login rather than a flag day.
 */
const N = 16_384
const R = 8
const P = 1
const KEYLEN = 64
const SALT_BYTES = 16

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const derived = (await scrypt(password.normalize('NFKC'), salt, KEYLEN, {
    N, r: R, p: P, maxmem: 64 * 1024 * 1024,
  }))
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts
  const n = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')

  let derived: Buffer
  try {
    derived = (await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: n, r, p, maxmem: 128 * 1024 * 1024,
    }))
  } catch {
    return false
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/**
 * Verified against a throwaway hash when an email is unknown, so a failed login
 * takes the same time whether or not the account exists.
 */
let decoyHash: Promise<string> | undefined
export async function burnTimeOnUnknownUser(password: string): Promise<void> {
  decoyHash ??= hashPassword('snackload-timing-decoy')
  await verifyPassword(password, await decoyHash)
}

export function passwordProblems(password: string): string[] {
  const problems: string[] = []
  if (password.length < 10) problems.push('Use at least 10 characters')
  if (password.length > 200) problems.push('Use at most 200 characters')
  if (!/[a-zA-Z]/.test(password)) problems.push('Include at least one letter')
  if (!/[0-9]/.test(password)) problems.push('Include at least one number')
  return problems
}
