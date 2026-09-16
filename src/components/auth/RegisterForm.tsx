'use client'

import { useActionState } from 'react'
import { Field, Input } from '@/components/ui/Field'
import { registerAction, type FormState } from '@/app/(auth)/actions'
import { FormError, SubmitButton } from './FormParts'

const EMPTY: FormState = {}

export function RegisterForm() {
  const [state, action] = useActionState(registerAction, EMPTY)

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormError message={state.error} />

      <Field label="Company name" htmlFor="companyName" error={state.fieldErrors?.companyName?.[0]}>
        <Input
          id="companyName"
          name="companyName"
          required
          autoComplete="organization"
          placeholder="Valley Snack Distributors"
          aria-invalid={Boolean(state.fieldErrors?.companyName)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" htmlFor="firstName" error={state.fieldErrors?.firstName?.[0]}>
          <Input id="firstName" name="firstName" required autoComplete="given-name" />
        </Field>
        <Field label="Last name" htmlFor="lastName" error={state.fieldErrors?.lastName?.[0]}>
          <Input id="lastName" name="lastName" required autoComplete="family-name" />
        </Field>
      </div>

      <Field label="Email" htmlFor="email" error={state.fieldErrors?.email?.[0]}>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoComplete="username"
          required
          aria-invalid={Boolean(state.fieldErrors?.email)}
        />
      </Field>

      <Field label="Phone" htmlFor="phone" hint="Optional — shown on receipts.">
        <Input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        error={state.fieldErrors?.password?.[0]}
        hint="At least 10 characters, with a number."
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={Boolean(state.fieldErrors?.password)}
        />
      </Field>

      <SubmitButton>Create company</SubmitButton>
    </form>
  )
}
