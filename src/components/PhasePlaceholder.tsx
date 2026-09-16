import { Card } from '@/components/ui/Card'
import { NavIcon } from '@/components/shell/NavIcon'
import type { IconName } from '@/lib/navigation'

/**
 * An honest placeholder for a destination whose phase has not shipped yet
 * (docs/06-roadmap.md). It names the phase and lists what will live here, rather
 * than pretending to be an empty feature — the navigation is real in Phase 1, the
 * screens behind it arrive on schedule.
 */
export function PhasePlaceholder({
  icon,
  title,
  phase,
  summary,
  capabilities,
}: {
  icon: IconName
  title: string
  phase: string
  summary: string
  capabilities: string[]
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <Card className="p-6">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-card bg-navy-50 text-navy-700 dark:bg-navy-900/60 dark:text-navy-100">
            <NavIcon name={icon} className="size-6" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <span className="inline-block rounded-full bg-flame-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-flame-700">
              {phase}
            </span>
            <h1 className="mt-2 text-xl font-extrabold text-ink">{title}</h1>
            <p className="mt-1 text-sm text-ink-muted">{summary}</p>
          </div>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-ink-subtle">
            What lands here
          </p>
          <ul className="mt-2 space-y-1.5">
            {capabilities.map((capability) => (
              <li key={capability} className="flex gap-2.5 text-sm text-ink">
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-flame-500" />
                {capability}
              </li>
            ))}
          </ul>
        </div>
      </Card>
    </div>
  )
}
