'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { isAppError } from '@/lib/errors'
import { inviteSchema } from '@/lib/schemas/auth'
import { requireAuth } from '@/server/auth/context'
import { inviteMember } from '@/server/services/auth.service'
import { revokeInvitation, setMemberStatus } from '@/server/services/user.service'

export type TeamFormState = {
  error?: string
  fieldErrors?: Record<string, string[]>
  /**
   * Email delivery is not wired up yet, so the invite link is surfaced here for
   * the admin to copy. When transactional email lands this becomes a confirmation.
   */
  inviteUrl?: string
  invitedEmail?: string
}

function toState(error: unknown): TeamFormState {
  if (error instanceof z.ZodError) {
    const fieldErrors: Record<string, string[]> = {}
    for (const issue of error.issues) {
      ;(fieldErrors[issue.path.join('.') || '_'] ??= []).push(issue.message)
    }
    return { error: 'Please fix the highlighted fields.', fieldErrors }
  }
  if (isAppError(error)) return { error: error.message }
  console.error('[team] unexpected failure', error)
  return { error: 'Something went wrong. Please try again.' }
}

export async function inviteMemberAction(
  _prev: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  try {
    const ctx = await requireAuth()
    const input = inviteSchema.parse(Object.fromEntries(formData))
    const result = await inviteMember(ctx, input)
    revalidatePath('/team')
    return { inviteUrl: result.acceptUrl, invitedEmail: input.email }
  } catch (error) {
    return toState(error)
  }
}

export async function revokeInviteAction(formData: FormData): Promise<void> {
  const ctx = await requireAuth()
  const id = String(formData.get('invitationId') ?? '')
  await revokeInvitation(ctx, id)
  revalidatePath('/team')
}

export async function setMemberStatusAction(formData: FormData): Promise<void> {
  const ctx = await requireAuth()
  const membershipId = String(formData.get('membershipId') ?? '')
  const status = formData.get('status') === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED'
  await setMemberStatus(ctx, membershipId, status)
  revalidatePath('/team')
}
