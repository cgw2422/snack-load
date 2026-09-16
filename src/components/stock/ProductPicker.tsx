'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, Search, X } from 'lucide-react'
import { formatQuantity } from '@/server/domain/uom'
import type { ProductHit, ProductUomOption } from './types'

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
}: {
  locationId?: string
  onPick: (product: ProductHit, uoms: ProductUomOption[]) => void
  placeholder?: string
  excludeIds?: Set<string>
}) {
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
        const response = await fetch(`/api/v1/products/search?${params}`)
        const data = await response.json()
        setResults({ term: query, items: data.items ?? [] })
      } catch {
        setResults({ term: query, items: [] })
      } finally {
        setLoadingTerm('')
      }
    }, 200)
  }, [term, locationId])

  async function choose(product: ProductHit) {
    const response = await fetch(`/api/v1/products/${product.id}/uoms`)
    const data = await response.json()
    onPick(product, data.uoms ?? [])
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
            <p className="px-4 py-3 text-sm text-ink-muted">Nothing matches that.</p>
          ) : (
            <ul className="divide-y divide-line">
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
