import type { Metadata } from 'next'
import { PhasePlaceholder } from '@/components/PhasePlaceholder'

export const metadata: Metadata = { title: "Settings" }

export default function Page() {
  return (
    <PhasePlaceholder
      icon={"settings"}
      title={"Settings"}
      phase={"Phase 1–8"}
      summary={"Company, team and integrations."}
      capabilities={[
        "Company profile, address and receipt footer",
        "Tax rates and payment terms",
        "QuickBooks Online connection, mapping and sync logs",
        "Audit history of important changes",
      ]}
    />
  )
}
