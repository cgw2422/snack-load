/**
 * The client-side durable store (docs/05 §3).
 *
 * IndexedDB rather than `localStorage`, for three reasons that all matter to a
 * runner: it survives a tab crash and an OS-killed background app, it is
 * asynchronous so a large cart never janks the stepper, and it is not capped at
 * the few megabytes a signature PNG would blow through.
 *
 * Written against the raw API with no wrapper library. The surface used here is
 * four calls wide, and a dependency would be more code than this file.
 */

const DATABASE = 'snackload'
const VERSION = 1

/** Carts in progress, keyed by the idempotency key minted at cart creation. */
export const DRAFTS = 'drafts'
/** Mutations waiting to reach the server, in the order they happened. */
export const QUEUE = 'queue'
/** Read-through cache for figures that must be labelled with their age. */
export const SNAPSHOTS = 'snapshots'

let opening: Promise<IDBDatabase> | null = null

export function available(): boolean {
  return typeof indexedDB !== 'undefined'
}

export function open(): Promise<IDBDatabase> {
  if (opening) return opening

  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(DRAFTS)) {
        db.createObjectStore(DRAFTS, { keyPath: 'idempotencyKey' })
      }

      if (!db.objectStoreNames.contains(QUEUE)) {
        const queue = db.createObjectStore(QUEUE, { keyPath: 'id' })
        // Replay is in the order the runner did the work, which is the order
        // that makes their day readable afterwards — and the order a payment
        // against a sale needs (docs/05 §3).
        queue.createIndex('bySequence', 'sequence', { unique: false })
        queue.createIndex('byStatus', 'status', { unique: false })
      }

      if (!db.objectStoreNames.contains(SNAPSHOTS)) {
        db.createObjectStore(SNAPSHOTS, { keyPath: 'key' })
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // Another tab upgrading the schema must not leave this one on a stale
      // connection that then throws on every write.
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      resolve(db)
    }

    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open.'))
    request.onblocked = () => reject(new Error('Another SnackLoad tab is blocking an upgrade.'))
  })

  return opening
}

function run<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

export async function put<T>(store: string, value: T): Promise<void> {
  const db = await open()
  const tx = db.transaction(store, 'readwrite')
  await run(tx.objectStore(store).put(value as unknown as IDBValidKey extends never ? never : object))
  await done(tx)
}

export async function get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await open()
  return run<T | undefined>(db.transaction(store, 'readonly').objectStore(store).get(key))
}

export async function all<T>(store: string): Promise<T[]> {
  const db = await open()
  return run<T[]>(db.transaction(store, 'readonly').objectStore(store).getAll())
}

export async function remove(store: string, key: IDBValidKey): Promise<void> {
  const db = await open()
  const tx = db.transaction(store, 'readwrite')
  await run(tx.objectStore(store).delete(key))
  await done(tx)
}

export async function clear(store: string): Promise<void> {
  const db = await open()
  const tx = db.transaction(store, 'readwrite')
  await run(tx.objectStore(store).clear())
  await done(tx)
}

/**
 * Waits for the transaction, not just the request.
 *
 * A request can succeed and its transaction still abort — on a quota failure,
 * or when the browser evicts storage under pressure. Resolving on the request
 * alone would report a queued sale as safely stored when it was not, which is
 * the one lie this whole file exists to avoid.
 */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'))
  })
}
