'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Search, X } from 'lucide-react'

/**
 * List search. Typing updates the URL, so a result page is shareable and the
 * back button behaves — and the server does the filtering, because a route with
 * 3,000 accounts must not ship all of them to a phone to filter client-side.
 */
export function SearchField({
  placeholder,
  paramName = 'search',
}: {
  placeholder: string
  paramName?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  const [value, setValue] = useState(params.get(paramName) ?? '')
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(debounce.current), [])

  function push(next: string) {
    const query = new URLSearchParams(params.toString())
    if (next) query.set(paramName, next)
    else query.delete(paramName)
    query.delete('page')
    startTransition(() => router.replace(`${pathname}?${query}`, { scroll: false }))
  }

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
        aria-hidden="true"
      />
      <input
        type="search"
        inputMode="search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => {
          const next = event.target.value
          setValue(next)
          clearTimeout(debounce.current)
          // Long enough that a phone keyboard does not fire a query per letter.
          debounce.current = setTimeout(() => push(next), 250)
        }}
        className="h-12 w-full rounded-xl border border-line-strong bg-surface-raised pl-10 pr-10 text-ink placeholder:text-ink-subtle focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/20"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setValue('')
            push('')
          }}
          className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-ink-subtle hover:bg-surface-sunken"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      {pending ? (
        <span className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse rounded-b-xl bg-flame-500" />
      ) : null}
    </div>
  )
}
