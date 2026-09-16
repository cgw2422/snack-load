import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Card } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Field'
import { AuthForm } from '@/components/auth/AuthForm'
import { getAuthContext } from '@/server/auth/context'
import { registerAction } from '../actions'

export const metadata: Metadata = { title: 'Start your company' }

export default async function RegisterPage() {
  if (await getAuthContext()) redirect('/')

  return (
    <Card className="p-5">
      <h1 className="text-xl font-bold text-ink">Start your company</h1>
      <p className="mt-1 mb-5 text-sm text-ink-muted">
        Set up your distribution company. You can invite your team next.
      </p>

      <AuthForm action={registerAction} submitLabel="Create company">
        {(state) => (
          <>
            <Field
              label="Company name"
              htmlFor="companyName"
              error={state.fieldErrors?.companyName?.[0]}
            >
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
          </>
        )}
      </AuthForm>

      <p className="mt-5 text-center text-sm text-ink-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold text-navy-600 hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  )
}
