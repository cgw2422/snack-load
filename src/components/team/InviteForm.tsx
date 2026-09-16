'use client'

import { useState } from 'react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select } from '@/components/ui/Field'
import { inviteMemberAction, type TeamFormState } from '@/app/(app)/team/actions'

const EMPTY: TeamFormState = {}

const ROLES = [
  { value: 'runner', label: 'Route Runner — sells on the route' },
  { value: 'warehouse', label: 'Warehouse — receives and loads stock' },
  { value: 'office', label: 'Office — customers, payments and reports' },
  { value: 'admin', label: 'Admin — full access' },
  { value: 'owner', label: 'Owner — full access and roles' },
]

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="primary" size="md" disabled={pending} block>
      {pending ? 'Sending…' : 'Send invite'}
    </Button>
  )
}

export function InviteForm() {
  const [state, action] = useActionState(inviteMemberAction, EMPTY)
  const [copied, setCopied] = useState(false)

  const fullUrl =
    state.inviteUrl && typeof window !== 'undefined'
      ? `${window.location.origin}${state.inviteUrl}`
      : state.inviteUrl

  return (
    <form action={action} className="space-y-3 px-4 pb-4">
      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-stop-500/30 bg-stop-500/5 px-3.5 py-3 text-sm text-stop-600"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      ) : null}

      {state.inviteUrl ? (
        <div className="rounded-xl border border-cash-500/30 bg-cash-50 px-3.5 py-3 dark:bg-cash-700/15">
          <p className="text-sm font-semibold text-cash-700 dark:text-cash-100">
            Invite ready for {state.invitedEmail}
          </p>
          <p className="mt-0.5 text-xs text-cash-700/80 dark:text-cash-100/80">
            Email delivery arrives with Phase 6 — send them this link for now.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-white px-2.5 py-2 text-xs dark:bg-black/20">
              {fullUrl}
            </code>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={async () => {
                if (!fullUrl) return
                await navigator.clipboard.writeText(fullUrl)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : null}

      <Field label="Email" htmlFor="invite-email" error={state.fieldErrors?.email?.[0]}>
        <Input
          id="invite-email"
          name="email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          required
          placeholder="mike@company.com"
        />
      </Field>

      <Field label="Role" htmlFor="invite-role" error={state.fieldErrors?.roleKey?.[0]}>
        <Select id="invite-role" name="roleKey" defaultValue="runner" required>
          {ROLES.map((role) => (
            <option key={role.value} value={role.value}>
              {role.label}
            </option>
          ))}
        </Select>
      </Field>

      <Submit />
    </form>
  )
}
