import type { Metadata } from 'next'
import { PhasePlaceholder } from '@/components/PhasePlaceholder'

export const metadata: Metadata = { title: "New sale" }

export default function Page() {
  return (
    <PhasePlaceholder
      icon={"plus"}
      title={"New sale"}
      phase={"Phase 5"}
      summary={"The fast in-store selling screen."}
      capabilities={[
        "Search or scan a product, barcode from the phone camera",
        "Cases, boxes, packs and individual units with stepper controls",
        "Customer-specific pricing, discounts and tax",
        "Sticky totals and one-tap checkout",
        "Inventory deducted from the selling truck as the sale posts",
      ]}
    />
  )
}
