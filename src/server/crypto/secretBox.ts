import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * Sealing secrets at rest (docs/04 §7).
 *
 * Used for OAuth tokens: a stolen database dump must not be a stolen QuickBooks
 * company. AES-256-GCM, so a tampered ciphertext fails to open rather than
 * decrypting to something attacker-chosen.
 *
 * Format: `v1:<iv>:<tag>:<ciphertext>`, all base64url. The version prefix is
 * what makes key rotation possible later without guessing at old rows.
 */

const VERSION = 'v1'
const IV_BYTES = 12

/**
 * The stored `ENCRYPTION_KEY` is an arbitrary-length string, and AES-256 needs
 * exactly 32 bytes. SHA-256 of the configured value is deterministic, so a
 * restart opens what the last process sealed.
 */
function key(): Buffer {
  return createHash('sha256').update(env().ENCRYPTION_KEY, 'utf8').digest()
}

export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':')
}

export function open(sealed: string): string {
  const [version, iv, tag, ciphertext] = sealed.split(':')
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Sealed value is not in a format this build understands.')
  }

  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** Opens a nullable column, returning null rather than throwing on absence. */
export function openOrNull(sealed: string | null | undefined): string | null {
  return sealed ? open(sealed) : null
}

/**
 * A token's last four characters, for a support conversation. Never the token.
 * Anything shorter than eight characters is masked entirely rather than
 * revealing most of a short secret.
 */
export function hint(secret: string | null | undefined): string {
  if (!secret || secret.length < 8) return '••••'
  return `••••${secret.slice(-4)}`
}

/** Constant-time compare, for signatures and verifier tokens. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
