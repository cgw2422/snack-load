import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'

export function Pagination({
  page,
  pageCount,
  total,
  noun,
  searchParams,
}: {
  page: number
  pageCount: number
  total: number
  noun: string
  searchParams: Record<string, string | undefined>
}) {
  if (pageCount <= 1) {
    return (
      <p className="px-4 py-3 text-center text-xs text-ink-subtle">
        {total.toLocaleString()} {noun}
      </p>
    )
  }

  const href = (target: number) => {
    const query = new URLSearchParams(
      Object.entries(searchParams).filter(([, v]) => v) as [string, string][],
    )
    query.set('page', String(target))
    return `?${query}`
  }

  const linkClass =
    'flex min-h-touch items-center gap-1 rounded-lg px-3 text-sm font-semibold transition-colors'

  return (
    <div className="flex items-center justify-between border-t border-line px-2 py-2">
      {page > 1 ? (
        <Link href={href(page - 1)} className={cn(linkClass, 'text-navy-600 hover:bg-surface-sunken')}>
          <ChevronLeft className="size-4" aria-hidden="true" />
          Previous
        </Link>
      ) : (
        <span className={cn(linkClass, 'text-ink-subtle')}>
          <ChevronLeft className="size-4" aria-hidden="true" />
          Previous
        </span>
      )}

      <span className="tnum text-xs text-ink-muted">
        Page {page} of {pageCount} · {total.toLocaleString()} {noun}
      </span>

      {page < pageCount ? (
        <Link href={href(page + 1)} className={cn(linkClass, 'text-navy-600 hover:bg-surface-sunken')}>
          Next
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      ) : (
        <span className={cn(linkClass, 'text-ink-subtle')}>
          Next
          <ChevronRight className="size-4" aria-hidden="true" />
        </span>
      )}
    </div>
  )
}
