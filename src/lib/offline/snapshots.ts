import { available, get, put, SNAPSHOTS } from './db'

/**
 * Read-through storage for figures that must be labelled with their age
 * (docs/05 §2).
 *
 * The service worker keeps HTTP responses; this keeps the parsed thing the UI
 * renders, together with when the *server* produced it. The two are not the
 * same number: `asOf` is the server's clock at the moment it answered, and it
 * is what the runner is shown. The device clock is only ever used to say how
 * long ago that was, which is a duration and survives a wrong timezone.
 */

export type Stored<T> = {
  key: string
  /** The server's timestamp, not the device's. */
  asOf: string
  /** Device clock at write time, so an unsynced phone still reports an age. */
  storedAt: number
  value: T
}

export async function remember<T extends { asOf: string }>(
  key: string,
  value: T,
): Promise<void> {
  if (!available()) return
  await put<Stored<T>>(SNAPSHOTS, { key, asOf: value.asOf, storedAt: Date.now(), value })
}

export async function recall<T>(key: string): Promise<Stored<T> | undefined> {
  if (!available()) return undefined
  return get<Stored<T>>(SNAPSHOTS, key).catch(() => undefined)
}

/** Keys are stable so the offline page can find what the app last stored. */
export const ROUTE_DAY = 'route-day'
export const CATALOG = 'catalog'
export const BALANCES = 'balances'
/**
 * Who was last signed in on this device.
 *
 * The offline page has no session — it is static, served by the service worker
 * when a navigation cannot reach the origin — so this is how it knows whose
 * queued work to show. It is an id pair, never a credential.
 */
export const IDENTITY = 'identity'
