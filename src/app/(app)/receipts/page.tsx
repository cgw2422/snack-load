import type { Metadata } from 'next'
import { PhasePlaceholder } from '@/components/PhasePlaceholder'

export const metadata: Metadata = { title: "Receipts" }

export default function Page() {
  return (
    <PhasePlaceholder
      icon={"receipt"}
      title={"Receipts"}
      phase={"Phase 6"}
      summary={"Every sale document, printable and sendable."}
      capabilities={[
        "Professional receipt with your branding and totals",
        "Customer signature captured on the touchscreen",
        "Print, PDF, email, text or share",
        "Full-page and 80mm thermal-friendly layouts",
      ]}
    />
  )
}
