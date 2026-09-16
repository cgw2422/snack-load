import type { Metadata } from 'next'
import { PhasePlaceholder } from '@/components/PhasePlaceholder'

export const metadata: Metadata = { title: "Inventory" }

export default function Page() {
  return (
    <PhasePlaceholder
      icon={"boxes"}
      title={"Inventory"}
      phase={"Phase 3"}
      summary={"Warehouse and truck stock on one ledger."}
      capabilities={[
        "Per-location balances — warehouse and each truck separately",
        "Receive supplier shipments by barcode or search",
        "Load and unload trucks, with suggested loads",
        "Adjustments for damage, expiry, missing and samples",
        "Full transaction history behind every number",
      ]}
    />
  )
}
