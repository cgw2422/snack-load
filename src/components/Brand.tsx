import { cn } from '@/lib/cn'

/** The truck-and-motion mark, inline so it inherits colour and scales crisply. */
export function SnackLoadMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={cn('h-8 w-8', className)} aria-hidden="true">
      <rect width="512" height="512" rx="112" fill="#0b2141" />
      <g fill="#f04e23">
        <rect x="52" y="196" width="116" height="26" rx="13" />
        <rect x="28" y="243" width="150" height="26" rx="13" />
        <rect x="60" y="290" width="104" height="26" rx="13" />
      </g>
      <g fill="#ffffff">
        <path d="M196 168h150a14 14 0 0 1 14 14v138H196a14 14 0 0 1-14-14V182a14 14 0 0 1 14-14z" />
        <path d="M374 214h46a22 22 0 0 1 17.6 8.8l32 42.7a22 22 0 0 1 4.4 13.2V306a14 14 0 0 1-14 14h-86V214z" />
      </g>
      <rect x="214" y="196" width="118" height="38" rx="9" fill="#2563ac" />
      <g fill="#0b2141">
        <circle cx="264" cy="344" r="42" />
        <circle cx="414" cy="344" r="42" />
      </g>
      <g fill="#ffffff">
        <circle cx="264" cy="344" r="19" />
        <circle cx="414" cy="344" r="19" />
      </g>
    </svg>
  )
}

export function SnackLoadWordmark({
  className,
  showTagline = false,
}: {
  className?: string
  showTagline?: boolean
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <SnackLoadMark />
      <div className="leading-none">
        <span className="text-[22px] font-extrabold tracking-tight text-navy-900 dark:text-white">
          Snack
        </span>
        <span className="text-[22px] font-extrabold tracking-tight text-flame-500">Load</span>
        {showTagline ? (
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-subtle">
            Inventory · Routes · Sales
          </p>
        ) : null}
      </div>
    </div>
  )
}
