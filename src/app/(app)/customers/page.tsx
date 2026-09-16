import type { Metadata } from 'next'
import { PhasePlaceholder } from '@/components/PhasePlaceholder'

export const metadata: Metadata = { title: "Customers" }

export default function Page() {
  return (
    <PhasePlaceholder
      icon={"store"}
      title={"Customers"}
      phase={"Phase 2"}
      summary={"Stores, balances and buying history."}
      capabilities={[
        "Gas stations, convenience stores, markets and independents",
        "Route, runner, visit day and frequency per account",
        "Outstanding balance, last visit and average order at a glance",
        "CSV and XLSX import with column mapping and update-in-place",
        "Bulk assign route, runner, visit day and payment terms",
      ]}
    />
  )
}
