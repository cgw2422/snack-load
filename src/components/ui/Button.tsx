import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'accent' | 'cash' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-navy-800 text-white hover:bg-navy-700 active:bg-navy-900 shadow-sm',
  accent: 'bg-flame-500 text-white hover:bg-flame-600 active:bg-flame-700 shadow-sm',
  cash: 'bg-cash-500 text-white hover:bg-cash-600 active:bg-cash-700 shadow-sm',
  secondary:
    'bg-surface-raised text-ink border border-line-strong hover:bg-surface-sunken active:bg-surface-sunken',
  ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
  danger: 'bg-stop-500 text-white hover:bg-stop-600 shadow-sm',
}

// lg is 56px: the height a route-runner primary action gets, so it can be hit
// while standing in a store holding a handheld (docs/05 §1).
const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5 rounded-lg',
  md: 'h-11 px-4 text-[15px] gap-2 rounded-xl',
  lg: 'h-14 px-6 text-base gap-2.5 rounded-xl',
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: Size
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', block, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center font-semibold transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        'select-none touch-manipulation',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...props}
    />
  )
})

/**
 * A link that looks like a button. Separate from `Button` on purpose: nesting an
 * anchor inside a `<button>` is invalid HTML and breaks keyboard navigation.
 */
export function ButtonLink({
  className,
  variant = 'primary',
  size = 'md',
  block,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: Variant
  size?: Size
  block?: boolean
}) {
  return (
    <a
      className={cn(
        'inline-flex items-center justify-center font-semibold transition-colors',
        'select-none touch-manipulation',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...props}
    />
  )
}
