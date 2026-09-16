import type { Prisma } from '@/generated/prisma/client'

/**
 * Transaction-client slices.
 *
 * A helper that runs inside a caller's transaction — the ledger engine, document
 * numbering, the audit writer — declares structurally which part of the client it
 * uses. Naming Prisma's generated transaction type instead would force every
 * caller onto one client or the other, and both are legitimate: app services run
 * through the tenant-scoped client, while registration and the seeder run on the
 * raw one because they are creating the organization itself (docs/04 §5).
 */

export type RawCapable = {
  $executeRaw(query: Prisma.Sql): Promise<number>
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
}

export type LedgerTx = RawCapable & {
  inventoryTransaction: {
    create(args: {
      data: Prisma.InventoryTransactionUncheckedCreateInput
      select: { id: true }
    }): Promise<{ id: string }>
  }
  inventoryTransactionLine: {
    createMany(args: {
      data: Prisma.InventoryTransactionLineUncheckedCreateInput[]
    }): Promise<unknown>
  }
  inventoryBalance: {
    update(args: {
      where: { id: string }
      data: { quantity: number; avgUnitCost: Prisma.Decimal }
    }): Promise<unknown>
  }
}

export type SequenceTx = RawCapable & {
  documentSequence: {
    update(args: { where: { id: string }; data: { nextNumber: number } }): Promise<unknown>
  }
}
