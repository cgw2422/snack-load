import type { Metadata } from 'next'
import { PhasePlaceholder } from '@/components/PhasePlaceholder'

export const metadata: Metadata = { title: "Suppliers" }

export default function Page() {
  return (
    <PhasePlaceholder
      icon={"factory"}
      title={"Suppliers"}
      phase={"Phase 2"}
      summary={"Who you buy from."}
      capabilities={[
        "Supplier records with contacts and lead times",
        "Products linked to their supplier",
        "Receiving history and cost tracking",
      ]}
    />
  )
}
