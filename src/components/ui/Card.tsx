import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'section' | 'article' | 'li'
}) {
  return (
    <Tag
      className={cn(
        'bg-surface-raised border border-line rounded-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
        className,
      )}
    >
      {children}
    </Tag>
  )
}

export function CardHeader({
  title,
  action,
  className,
}: {
  title: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 px-4 pt-4 pb-2', className)}>
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      {action}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon ? <div className="text-ink-subtle">{icon}</div> : null}
      <div>
        <p className="font-semibold text-ink">{title}</p>
        {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  )
}
