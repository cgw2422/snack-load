import type { Metadata } from 'next'
import { ImportLanding } from '@/components/import/ImportLanding'

export const metadata: Metadata = { title: 'Import products' }

export default function Page() {
  return (
    <ImportLanding
      type="PRODUCTS"
      noun="products"
      backHref="/inventory/products"
      backLabel="Products"
    />
  )
}
