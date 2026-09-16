import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { StockPageShell } from '@/components/stock/StockPageShell'
import { ReceiveForm } from '@/components/stock/ReceiveForm'

export const metadata: Metadata = { title: 'Receive stock' }

export default async function ReceivePage() {
  const ctx = await requireAuth()
  if (!can(ctx, 'inventory:receive')) redirect('/inventory')

  const prisma = db(ctx)
  const [warehouses, suppliers] = await Promise.all([
    prisma.inventoryLocation.findMany({
      where: { kind: 'WAREHOUSE', active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.supplier.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ])

  return (
    <StockPageShell
      title="Receive stock"
      description="Bring a supplier shipment into your warehouse."
    >
      <ReceiveForm warehouses={warehouses} suppliers={suppliers} />
    </StockPageShell>
  )
}
