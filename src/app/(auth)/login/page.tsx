import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Card } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Field'
import { AuthForm } from '@/components/auth/AuthForm'
import { getAuthContext } from '@/server/auth/context'
import { loginAction } from '../actions'

export const metadata: Metadata = { title: 'Sign in' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  if (await getAuthContext()) redirect('/')
  const { next } = await searchParams

  return (
    <Card className="p-5">
      <h1 className="text-xl font-bold text-ink">Sign in</h1>
      <p className="mt-1 mb-5 text-sm text-ink-muted">Welcome back. Let&apos;s get rolling.</p>

      <AuthForm action={loginAction} submitLabel="Sign in">
        {(state) => (
          <>
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
          </>
        )}
      </AuthForm>

      <p className="mt-5 text-center text-sm text-ink-muted">
        New to SnackLoad?{' '}
        <Link href="/register" className="font-semibold text-navy-600 hover:underline">
          Start your company
        </Link>
      </p>
    </Card>
  )
}
