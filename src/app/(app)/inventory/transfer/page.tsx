import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { can, requireAuth } from '@/server/auth/context'
import { db } from '@/server/db/tenant'
import { Card } from '@/components/ui/Card'
import { StockPageShell } from '@/components/stock/StockPageShell'
import { TransferForm } from '@/components/stock/TransferForm'

export const metadata: Metadata = { title: 'Transfer stock' }

export default async function TransferPage() {
  const ctx = await requireAuth()
  if (!can(ctx, 'inventory:transfer')) redirect('/inventory')

  const locations = await db(ctx).inventoryLocation.findMany({
    where: { active: true },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, kind: true },
  })

  return (
    <StockPageShell
      title="Transfer stock"
      description="Move stock between your warehouses and trucks."
    >
      {locations.length < 2 ? (
        <Card className="p-4">
          <p className="text-sm text-ink-muted">
            You need at least two stock locations before anything can move between them.
          </p>
        </Card>
      ) : (
        <TransferForm locations={locations} />
      )}
    </StockPageShell>
  )
}
