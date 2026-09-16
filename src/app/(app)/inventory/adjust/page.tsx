import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { StockPageShell } from '@/components/stock/StockPageShell'
import { AdjustForm } from '@/components/stock/AdjustForm'

export const metadata: Metadata = { title: 'Adjust stock' }

export default async function AdjustPage() {
  const ctx = await requireAuth()
  if (!can(ctx, 'inventory:adjust')) redirect('/inventory')

  const locations = await db(ctx).inventoryLocation.findMany({
    where: { active: true },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, kind: true },
  })

  return (
    <StockPageShell
      title="Adjust stock"
      description="Damage, expiry, shrinkage, samples — or a physical count."
    >
      <AdjustForm locations={locations} />
    </StockPageShell>
  )
}
