'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { FormState } from '@/app/(auth)/actions'

const EMPTY: FormState = {}

export function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" variant="accent" block disabled={pending}>
      {pending ? 'Working…' : children}
    </Button>
  )
}

export function AuthForm({
  action,
  submitLabel,
  children,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>
  submitLabel: string
  children: (state: FormState) => ReactNode
}) {
  const [state, formAction] = useActionState(action, EMPTY)

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      ) : null}

      {children(state)}

      <SubmitButton>{submitLabel}</SubmitButton>
    </form>
  )
}
