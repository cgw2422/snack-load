import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

export function StockPageShell({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <Link
        href="/inventory"
        className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-navy-600 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Inventory
      </Link>

      <div>
        <h1 className="text-xl font-extrabold text-ink">{title}</h1>
        <p className="text-sm text-ink-muted">{description}</p>
      </div>

      {children}
    </div>
  )
}
