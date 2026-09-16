'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'

/**
 * Route and date pickers for the planner. Both push to the URL so the due list
 * is a shareable, back-button-friendly server render rather than client state.
 */
export function PlannerFilters({
  templates,
  templateId,
  serviceDate,
}: {
  templates: { id: string; name: string; dayOfWeek: string | null }[]
  templateId: string
  serviceDate: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function go(next: { template?: string; date?: string }) {
    const params = new URLSearchParams({
      template: next.template ?? templateId,
      date: next.date ?? serviceDate,
    })
    startTransition(() => router.push(`/routes/plan?${params}`))
  }

  return (
    <Card className="grid gap-3 p-4 sm:grid-cols-2" aria-busy={pending}>
      <Field label="Route" htmlFor="template">
        <Select
          id="template"
          value={templateId}
          onChange={(event) => go({ template: event.target.value })}
        >
          {templates.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
              {option.dayOfWeek ? ` · ${title(option.dayOfWeek)}s` : ''}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Service date" htmlFor="date">
        <Input
          id="date"
          type="date"
          value={serviceDate}
          onChange={(event) => {
            if (event.target.value) go({ date: event.target.value })
          }}
        />
      </Field>
    </Card>
  )
}

function title(day: string): string {
  return day.charAt(0) + day.slice(1).toLowerCase()
}
