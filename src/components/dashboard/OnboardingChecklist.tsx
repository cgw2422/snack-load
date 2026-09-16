import Link from 'next/link'
import { Check, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/cn'
import { ONBOARDING_LABELS, ONBOARDING_STEPS } from '@/server/services/provisioning'

/**
 * The setup checklist a brand-new company lands on (spec §49). It disappears on
 * its own once every required step is done — nobody should have to dismiss it.
 */
export function OnboardingChecklist({ state }: { state: Record<string, boolean> }) {
  const steps = ONBOARDING_STEPS.map((key) => ({
    key,
    done: Boolean(state[key]),
    ...ONBOARDING_LABELS[key],
  }))

  const required = steps.filter((s) => !s.optional)
  const doneCount = required.filter((s) => s.done).length
  if (doneCount === required.length) return null

  const percent = Math.round((doneCount / required.length) * 100)

  return (
    <Card className="overflow-hidden">
      <div className="bg-navy-900 px-4 py-4 text-white">
        <p className="text-sm font-semibold text-navy-200">Welcome to SnackLoad</p>
        <h2 className="mt-0.5 text-lg font-bold">Let&apos;s get you rolling</h2>
        <div className="mt-3 flex items-center gap-3">
          <div
            className="h-2 flex-1 overflow-hidden rounded-full bg-white/20"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Setup progress"
          >
            <div className="h-full rounded-full bg-flame-500" style={{ width: `${percent}%` }} />
          </div>
          <span className="tnum text-sm font-bold">
            {doneCount}/{required.length}
          </span>
        </div>
      </div>

      <ol className="divide-y divide-line">
        {steps.map((step, index) => (
          <li key={step.key}>
            <Link
              href={step.href}
              className="flex min-h-touch items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
            >
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                  step.done
                    ? 'bg-cash-500 text-white'
                    : 'border-2 border-line-strong text-ink-subtle',
                )}
              >
                {step.done ? <Check className="size-4" aria-hidden="true" /> : index + 1}
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block text-sm font-semibold',
                    step.done ? 'text-ink-subtle line-through' : 'text-ink',
                  )}
                >
                  {step.title}
                  {step.optional ? (
                    <span className="ml-1.5 text-[11px] font-medium text-ink-subtle">
                      optional
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-ink-muted">{step.description}</span>
              </span>

              <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  )
}
