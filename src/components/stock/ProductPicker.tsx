'use client'

import { useEffect, useRef, useState } from 'react'
import { useOffline } from 'next/offline'
import { CloudOff, Plus, Search, X } from 'lucide-react'
import { formatQuantity } from '@/server/domain/uom'
import { cachedUoms, searchCachedCatalog } from '@/lib/offline/catalogSearch'
import { BALANCES, CATALOG, recall } from '@/lib/offline/snapshots'
import type { BalanceSnapshot, CatalogSnapshot } from '@/lib/offline/types'
import type { ProductHit, ProductUomOption } from './types'

type Cache = { catalog: CatalogSnapshot | null; balances: BalanceSnapshot | null }

/**
 * The cached truck list, read once and kept for the rest of the cart.
 *
 * Outside the component so the effect that uses it needs no dependency on it,
 * and so a re-render while the runner is typing cannot start a second read.
 */
async function loadCache(cache: Cache): Promise<{ catalog: CatalogSnapshot; balances: BalanceSnapshot | null } | null> {
  cache.catalog ??= (await recall<CatalogSnapshot>(CATALOG))?.value ?? null
  cache.balances ??= (await recall<BalanceSnapshot>(BALANCES))?.value ?? null
  return cache.catalog ? { catalog: cache.catalog, balances: cache.balances } : null
}

/**
 * Search-and-add for every line-item screen.
 *
 * Optimised for someone in a warehouse doorway: results appear as they type, the
 * whole row is the target, and the field stays focused so the next product can
 * be typed straight away.
 */
export function ProductPicker({
  locationId,
  onPick,
  placeholder = 'Search or scan a product',
  excludeIds,
  offlineFallback = false,
}: {
  locationId?: string
  onPick: (product: ProductHit, uoms: ProductUomOption[]) => void
  placeholder?: string
  excludeIds?: Set<string>
  /**
   * Fall back to the cached truck catalogue when the server cannot be reached.
   *
   * Opt-in, and only the sell screen opts in. The warehouse screens — receiving,
   * transfers, adjustments — search the whole product list, which this device
   * does not have, and their submits are not queued either, so offering them a
   * partial answer would only waste a runner's time.
   */
  offlineFallback?: boolean
}) {
  const offline = useOffline()
  const cache = useRef<Cache>({ catalog: null, balances: null })
  const [term, setTerm] = useState('')
  // Results carry the term they belong to, so a stale response for a term the
  // person has already changed simply stops matching and is not shown. That
  // removes the need to clear state synchronously as they type.
  const [results, setResults] = useState<{ term: string; items: ProductHit[] }>({
    term: '',
    items: [],
  })
  const [loadingTerm, setLoadingTerm] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(debounce.current), [])

  useEffect(() => {
    const query = term.trim()
    clearTimeout(debounce.current)
    if (query.length < 2) return

    debounce.current = setTimeout(async () => {
      setLoadingTerm(query)
      const params = new URLSearchParams({ q: query, limit: '12' })
      if (locationId) params.set('locationId', locationId)
      try {
        if (offlineFallback && offline) throw new Error('offline')
        const response = await fetch(`/api/v1/products/search?${params}`)
        if (!response.ok) throw new Error(String(response.status))
        const data = await response.json()
        setResults({ term: query, items: data.items ?? [] })
      } catch {
        const held = offlineFallback ? await loadCache(cache.current) : null
        setResults({
          term: query,
          items: held ? searchCachedCatalog(held.catalog, held.balances, query) : [],
        })
      } finally {
        setLoadingTerm('')
      }
    }, 200)
  }, [term, locationId, offline, offlineFallback])

  async function resolveUoms(product: ProductHit): Promise<ProductUomOption[]> {
    try {
      if (offlineFallback && offline) throw new Error('offline')
      const response = await fetch(`/api/v1/products/${product.id}/uoms`)
      if (!response.ok) throw new Error(String(response.status))
      return ((await response.json()).uoms ?? []) as ProductUomOption[]
    } catch {
      const held = offlineFallback ? await loadCache(cache.current) : null
      return held ? cachedUoms(held.catalog, product.id) : []
    }
  }

  async function choose(product: ProductHit) {
    const uoms = await resolveUoms(product)

    onPick(product, uoms)
    setTerm('')
    // Keep focus so the next product can be typed without reaching for the field.
    input.current?.focus()
  }

  const query = term.trim()
  const fresh = results.term === query ? results.items : []
  const visible = excludeIds ? fresh.filter((r) => !excludeIds.has(r.id)) : fresh
  const loading = loadingTerm === query || (results.term !== query && query.length >= 2)

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
        aria-hidden="true"
      />
      <input
        ref={input}
        type="search"
        inputMode="search"
        value={term}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setTerm(e.target.value)}
        className="h-12 w-full rounded-xl border border-line-strong bg-surface-raised pl-10 pr-10 text-ink placeholder:text-ink-subtle focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/20"
      />
      {term ? (
        <button
          type="button"
          aria-label="Clear"
          onClick={() => setTerm('')}
          className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-ink-subtle hover:bg-surface-sunken"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}

      {term.trim().length >= 2 ? (
        <div className="absolute inset-x-0 top-[calc(100%+0.375rem)] z-20 max-h-80 overflow-y-auto rounded-xl border border-line bg-surface-raised shadow-xl">
          {loading && visible.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-muted">Searching…</p>
          ) : visible.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-muted">
              {offlineFallback && offline
                ? 'Nothing on this truck matches that. With no signal only what you are carrying can be searched.'
                : 'Nothing matches that.'}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {offlineFallback && offline ? (
                <li className="flex items-center gap-2 bg-alert-500/10 px-4 py-2 text-xs font-semibold text-alert-600 dark:text-alert-400">
                  <CloudOff className="size-3.5 shrink-0" aria-hidden="true" />
                  From this truck’s cached list.
                </li>
              ) : null}
              {visible.map((product) => (
                <li key={product.id}>
                  <button
                    type="button"
                    onClick={() => choose(product)}
                    className="flex min-h-touch w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">
                        {product.name}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        SKU {product.sku}
                        {product.brand ? ` · ${product.brand}` : ''}
                      </span>
                    </span>
                    <span className="tnum shrink-0 text-xs font-semibold text-ink-muted">
                      {formatQuantity(
                        product.onHand ?? product.onHandBaseUnits,
                        product.unitsPerCase,
                      )}
                    </span>
                    <Plus className="size-4 shrink-0 text-flame-500" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
