import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardHeader } from '@/components/ui/Card'
import { InviteForm } from '@/components/team/InviteForm'
import { can, requireAuth } from '@/server/auth/context'
import { listTeam } from '@/server/services/user.service'
import { relativeTime } from '@/lib/dates'
import { setMemberStatusAction, revokeInviteAction } from './actions'

export const metadata: Metadata = { title: 'Team' }

export default async function TeamPage() {
  const ctx = await requireAuth()
  if (!can(ctx, 'user:read')) redirect('/')

  const { members, invites } = await listTeam(ctx)
  const canInvite = can(ctx, 'user:invite')
  const canDeactivate = can(ctx, 'user:deactivate')

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <div>
        <h1 className="text-xl font-extrabold text-ink">Team</h1>
        <p className="text-sm text-ink-muted">
          Owners, office staff, warehouse crew and route runners.
        </p>
      </div>

      <Card>
        <CardHeader
          title={`${members.length} ${members.length === 1 ? 'person' : 'people'}`}
        />
        <ul className="divide-y divide-line">
          {members.map((member) => (
            <li key={member.membershipId} className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-navy-100 text-xs font-bold text-navy-800">
                {member.name
                  .split(' ')
                  .map((p) => p.charAt(0))
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink">
                  {member.name}
                  {member.isSelf ? (
                    <span className="ml-1.5 text-xs font-medium text-ink-subtle">you</span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-ink-muted">
                  {member.email} · {member.roleName}
                </span>
                <span className="block text-xs text-ink-subtle">
                  {member.lastLoginAt
                    ? `Last signed in ${relativeTime(new Date(member.lastLoginAt))}`
                    : 'Has not signed in yet'}
                </span>
              </span>

              {member.status !== 'ACTIVE' ? (
                <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-bold text-ink-subtle">
                  Suspended
                </span>
              ) : null}

              {canDeactivate && !member.isSelf ? (
                <form action={setMemberStatusAction}>
                  <input type="hidden" name="membershipId" value={member.membershipId} />
                  <input
                    type="hidden"
                    name="status"
                    value={member.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'}
                  />
                  <button
                    type="submit"
                    className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
                  >
                    {member.status === 'ACTIVE' ? 'Suspend' : 'Restore'}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      {invites.length > 0 ? (
        <Card>
          <CardHeader title="Pending invites" />
          <ul className="divide-y divide-line">
            {invites.map((invite) => (
              <li key={invite.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {invite.email}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {invite.roleName} · invited by {invite.invitedByName}
                  </span>
                </span>
                {canInvite ? (
                  <form action={revokeInviteAction}>
                    <input type="hidden" name="invitationId" value={invite.id} />
                    <button
                      type="submit"
                      className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-stop-600 transition-colors hover:bg-stop-500/5"
                    >
                      Revoke
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {canInvite ? (
        <Card>
          <CardHeader title="Invite someone" />
          <InviteForm />
        </Card>
      ) : null}
    </div>
  )
}
