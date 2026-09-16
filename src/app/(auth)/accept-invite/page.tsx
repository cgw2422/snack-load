import Link from 'next/link'
import type { Metadata } from 'next'
import { Card } from '@/components/ui/Card'
import { AcceptInviteForm } from '@/components/auth/AcceptInviteForm'
import { isAppError } from '@/lib/errors'
import { previewInvitation } from '@/server/services/auth.service'
import type { InvitationPreview } from '@/server/services/auth.service'

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
      problem = isAppError(error) ? error.message : 'That invitation could not be opened.'
    }
  }

  if (!preview || !token) {
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
        You&apos;ve been invited as{' '}
        <span className="font-semibold text-ink">{preview.roleName}</span>. Set your password to get
        started.
      </p>

      <AcceptInviteForm token={token} email={preview.email} userExists={preview.userExists} />
    </Card>
  )
}
