import type { Metadata } from 'next'
import { PhasePlaceholder } from '@/components/PhasePlaceholder'

export const metadata: Metadata = { title: "Receivables" }

export default function Page() {
  return (
    <PhasePlaceholder
      icon={"wallet"}
      title={"Receivables"}
      phase={"Phase 6"}
      summary={"What every store owes you."}
      capabilities={[
        "Open invoices with due dates and aging buckets",
        "Record payments: cash, check, card, ACH or on account",
        "Apply payments oldest-first or to specific invoices",
        "Partial payments and credit on account",
      ]}
    />
  )
}
