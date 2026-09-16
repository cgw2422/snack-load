'use client'

import { useActionState } from 'react'
import { Field, Input } from '@/components/ui/Field'
import { acceptInviteAction, type FormState } from '@/app/(auth)/actions'
import { FormError, SubmitButton } from './FormParts'

const EMPTY: FormState = {}

export function AcceptInviteForm({
  token,
  email,
  userExists,
}: {
  token: string
  email: string
  userExists: boolean
}) {
  const [state, action] = useActionState(acceptInviteAction, EMPTY)

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormError message={state.error} />
      <input type="hidden" name="token" value={token} />

      <Field label="Email" htmlFor="invite-email">
        <Input id="invite-email" value={email} disabled readOnly />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" htmlFor="firstName" error={state.fieldErrors?.firstName?.[0]}>
          <Input id="firstName" name="firstName" required autoComplete="given-name" />
        </Field>
        <Field label="Last name" htmlFor="lastName" error={state.fieldErrors?.lastName?.[0]}>
          <Input id="lastName" name="lastName" required autoComplete="family-name" />
        </Field>
      </div>

      <Field
        label={userExists ? 'Your existing password' : 'Create a password'}
        htmlFor="password"
        error={state.fieldErrors?.password?.[0]}
        hint={
          userExists
            ? 'You already have a SnackLoad account — use that password.'
            : 'At least 10 characters, with a number.'
        }
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={userExists ? 'current-password' : 'new-password'}
          required
          aria-invalid={Boolean(state.fieldErrors?.password)}
        />
      </Field>

      <SubmitButton>Join the team</SubmitButton>
    </form>
  )
}
