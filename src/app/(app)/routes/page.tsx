import type { Metadata } from 'next'
import { PhasePlaceholder } from '@/components/PhasePlaceholder'

export const metadata: Metadata = { title: "Routes" }

export default function Page() {
  return (
    <PhasePlaceholder
      icon={"route"}
      title={"Routes"}
      phase={"Phase 4"}
      summary={"Route templates, recurring schedules and the runner workflow."}
      capabilities={[
        "Accounts due on a given day, built into a route automatically",
        "Geographic stop optimisation and drag-to-reorder",
        "Map view with stop numbers and hand-off to native navigation",
        "Reassign a runner's remaining stops without losing route history",
        "The stop workflow: arrive, sell, collect, complete",
      ]}
    />
  )
}
