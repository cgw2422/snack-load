import type { Metadata } from 'next'
import { PhasePlaceholder } from '@/components/PhasePlaceholder'

export const metadata: Metadata = { title: "Reports" }

export default function Page() {
  return (
    <PhasePlaceholder
      icon={"chart"}
      title={"Reports"}
      phase={"Phase 7"}
      summary={"Sales, profit, inventory, routes and receivables."}
      capabilities={[
        "Sales by day, customer, product, brand, route, runner and tender",
        "Profitability with revenue, COGS, gross profit and margin",
        "Declining accounts, measured against their own history",
        "Inventory value, movement, shrinkage and slow movers",
        "AR aging with drilldown to invoice and payment",
        "Export to PDF, CSV and Excel",
      ]}
    />
  )
}
