'use client'

import { useActionState } from 'react'
import { Field, Input } from '@/components/ui/Field'
import { loginAction, type FormState } from '@/app/(auth)/actions'
import { FormError, SubmitButton } from './FormParts'

const EMPTY: FormState = {}

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState(loginAction, EMPTY)

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormError message={state.error} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <Field label="Email" htmlFor="email" error={state.fieldErrors?.email?.[0]}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          required
          placeholder="you@company.com"
          aria-invalid={Boolean(state.fieldErrors?.email)}
        />
      </Field>

      <Field label="Password" htmlFor="password" error={state.fieldErrors?.password?.[0]}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={Boolean(state.fieldErrors?.password)}
        />
      </Field>

      <SubmitButton>Sign in</SubmitButton>
    </form>
  )
}
