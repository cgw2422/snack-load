import type { Metadata } from 'next'
import { ImportLanding } from '@/components/import/ImportLanding'

export const metadata: Metadata = { title: 'Import stores' }

export default function Page() {
  return (
    <ImportLanding type="CUSTOMERS" noun="stores" backHref="/customers" backLabel="Customers" />
  )
}
