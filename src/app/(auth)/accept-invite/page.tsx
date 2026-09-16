import Link from 'next/link'
import type { Metadata } from 'next'
import { Card } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Field'
import { AuthForm } from '@/components/auth/AuthForm'
import { isAppError } from '@/lib/errors'
import { previewInvitation } from '@/server/services/auth.service'
import type { InvitationPreview } from '@/server/services/auth.service'
import { acceptInviteAction } from '../actions'

export const metadata: Metadata = { title: 'Join your team' }

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  let preview: InvitationPreview | null = null
  let problem: string | null = null

  if (!token) {
    problem = 'This invitation link is missing its code.'
  } else {
    try {
      preview = await previewInvitation(token)
    } catch (error) {
      problem = isAppError(error)
        ? error.message
        : 'That invitation could not be opened.'
    }
  }

  if (!preview) {
    return (
      <Card className="p-5">
        <h1 className="text-xl font-bold text-ink">Invitation unavailable</h1>
        <p className="mt-2 text-sm text-ink-muted">{problem}</p>
        <p className="mt-5 text-sm text-ink-muted">
          Ask whoever invited you to send a new link, or{' '}
          <Link href="/login" className="font-semibold text-navy-600 hover:underline">
            sign in
          </Link>
          .
        </p>
      </Card>
    )
  }

  return (
    <Card className="p-5">
      <h1 className="text-xl font-bold text-ink">Join {preview.organizationName}</h1>
      <p className="mt-1 mb-5 text-sm text-ink-muted">
        You&apos;ve been invited as <span className="font-semibold text-ink">{preview.roleName}</span>.
        Set your password to get started.
      </p>

      <AuthForm action={acceptInviteAction} submitLabel="Join the team">
        {(state) => (
          <>
            <input type="hidden" name="token" value={token} />

            <Field label="Email" htmlFor="invite-email">
              <Input id="invite-email" value={preview.email} disabled readOnly />
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
              label={preview.userExists ? 'Your existing password' : 'Create a password'}
              htmlFor="password"
              error={state.fieldErrors?.password?.[0]}
              hint={
                preview.userExists
                  ? 'You already have a SnackLoad account — use that password.'
                  : 'At least 10 characters, with a number.'
              }
            >
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={preview.userExists ? 'current-password' : 'new-password'}
                required
                aria-invalid={Boolean(state.fieldErrors?.password)}
              />
            </Field>
          </>
        )}
      </AuthForm>
    </Card>
  )
}
