import { createId } from '@paralleldrive/cuid2'
import { Prisma } from '@/generated/prisma/client'
import type { InventoryTransactionType } from '@/generated/prisma/enums'
import type { LedgerTx, RawCapable, SequenceTx } from '@/server/db/tx'
import { AppError } from '@/lib/errors'
import { m, round6 } from '@/server/domain/money'

/**
 * The inventory ledger posting engine (docs/02 §L1–L6).
 *
 * This is the single write path for stock. Nothing else in SnackLoad is allowed
 * to touch `inventory_balance`, because the balance is a cache and this function
 * is what keeps it equal to the sum of the ledger.
 *
 * It takes a raw transaction client rather than a scoped one: it runs inside the
 * caller's transaction (a sale, a truck load, a receipt) so that stock, money and
 * audit either all commit or none do. That means organizationId is passed and
 * applied explicitly on every statement here.
 */

/**
 * Movements allowed to take stock OUT of a non-sellable hold location.
 *
 * Only the reversal of the posting that put it there. Goods sitting in
 * DAMAGED_HOLD, EXPIRED_HOLD or SUPPLIER_RETURN_HOLD came back from a store and
 * must not re-enter sellable stock by any other route — not a transfer, not an
 * adjustment, and not a truck load. Writing them off or shipping them to the
 * supplier is a disposal workflow that does not exist yet; when it is built, it
 * posts its own transaction type and that type joins this set. Until then the
 * honest behaviour is to refuse, not to let an ad-hoc transfer do it silently.
 */
const HOLD_RELEASING_TYPES: ReadonlySet<InventoryTransactionType> = new Set(['REVERSAL'])

/** Movements that relocate stock rather than create or consume it. */
const CONSERVING_TYPES: ReadonlySet<InventoryTransactionType> = new Set([
  'TRANSFER', 'TRUCK_LOAD', 'TRUCK_UNLOAD',
])

export type LedgerLineInput = {
  productId: string
  locationId: string
  /** Signed base units. Negative removes from that location. */
  quantityDelta: number
  /** Acquisition cost of one base unit. Required for incoming stock. */
  unitCost?: string | number
  notes?: string
}

export type PostTransactionInput = {
  type: InventoryTransactionType
  lines: LedgerLineInput[]
  occurredAt?: Date
  createdByUserId?: string | null
  referenceType?: string
  referenceId?: string
  reasonCode?: string
  notes?: string
  idempotencyKey?: string
  reversalOfId?: string
  /** Escape hatch for counts and for organizations that allow negative truck stock. */
  allowNegative?: boolean
}

export type PostedTransaction = {
  transactionId: string
  /** Resulting quantity per `${locationId}:${productId}`. */
  balances: Map<string, number>
}

export class InsufficientStockError extends AppError {
  constructor(
    readonly productId: string,
    readonly locationId: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(
      'INSUFFICIENT_STOCK',
      `Not enough stock: ${requested} requested, ${available} on hand.`,
      { productId, locationId, requested, available },
    )
  }
}

type LockedBalance = {
  id: string
  quantity: number
  avgUnitCost: Prisma.Decimal
}

const key = (locationId: string, productId: string) => `${locationId}:${productId}`

export async function postInventoryTransaction(
  tx: LedgerTx,
  organizationId: string,
  input: PostTransactionInput,
): Promise<PostedTransaction> {
  if (input.lines.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'An inventory transaction needs at least one line.')
  }
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantityDelta)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Quantity must be a whole number of base units, got ${line.quantityDelta}.`,
      )
    }
    if (line.quantityDelta === 0) {
      throw new AppError('VALIDATION_FAILED', 'An inventory line cannot move zero units.')
    }
  }

  assertConservation(input)
  await assertHoldsNotDrained(tx, organizationId, input)

  // Lock in a fixed order so two concurrent postings can never deadlock
  // against each other (docs/02 §I2).
  const pairs = [...new Set(input.lines.map((l) => key(l.locationId, l.productId)))].sort()

  const locked = new Map<string, LockedBalance>()
  for (const pair of pairs) {
    const [locationId, productId] = pair.split(':')
    locked.set(pair, await lockBalance(tx, organizationId, locationId, productId))
  }

  // Apply every line to the locked snapshot before writing anything, so a
  // shortfall on line 8 does not leave lines 1–7 posted.
  const working = new Map<string, { quantity: number; avgUnitCost: Prisma.Decimal }>()
  for (const [pair, balance] of locked) {
    working.set(pair, { quantity: balance.quantity, avgUnitCost: balance.avgUnitCost })
  }

  // On a transfer, stock arrives carrying the cost it left with. Without this
  // the receiving location averages against zero and a freshly loaded truck
  // reports its inventory as worthless (docs/02 §L5).
  const transferCost = new Map<string, Prisma.Decimal>()
  if (CONSERVING_TYPES.has(input.type)) {
    const outgoing = new Map<string, { units: number; value: Prisma.Decimal }>()
    for (const line of input.lines) {
      if (line.quantityDelta >= 0) continue
      const source = locked.get(key(line.locationId, line.productId))!
      const units = Math.abs(line.quantityDelta)
      const entry = outgoing.get(line.productId) ?? { units: 0, value: m(0) as unknown as Prisma.Decimal }
      outgoing.set(line.productId, {
        units: entry.units + units,
        value: m(entry.value).plus(m(source.avgUnitCost).times(units)) as unknown as Prisma.Decimal,
      })
    }
    for (const [productId, entry] of outgoing) {
      if (entry.units > 0) {
        transferCost.set(productId, round6(m(entry.value).dividedBy(entry.units)) as unknown as Prisma.Decimal)
      }
    }
  }

  const resolved: {
    line: LedgerLineInput
    unitCost: string
    balanceAfter: number
  }[] = []

  for (const line of input.lines) {
    const pair = key(line.locationId, line.productId)
    const state = working.get(pair)!
    const nextQuantity = state.quantity + line.quantityDelta

    if (nextQuantity < 0 && !input.allowNegative) {
      throw new InsufficientStockError(
        line.productId,
        line.locationId,
        Math.abs(line.quantityDelta),
        state.quantity,
      )
    }

    let unitCost: Prisma.Decimal
    if (line.quantityDelta > 0) {
      // Incoming stock re-weights the location's moving average (docs/02 §L5).
      const incoming =
        line.unitCost !== undefined
          ? m(line.unitCost)
          : m(transferCost.get(line.productId) ?? state.avgUnitCost)
      unitCost = incoming as unknown as Prisma.Decimal
      const priorValue = m(state.avgUnitCost).times(Math.max(state.quantity, 0))
      const incomingValue = incoming.times(line.quantityDelta)
      const totalQuantity = Math.max(state.quantity, 0) + line.quantityDelta
      state.avgUnitCost = (
        totalQuantity > 0
          ? round6(priorValue.plus(incomingValue).dividedBy(totalQuantity))
          : incoming
      ) as unknown as Prisma.Decimal
    } else {
      // Outgoing stock leaves at the location's current average; that value is
      // copied onto the sale line so COGS is fixed at the moment of sale.
      unitCost = m(state.avgUnitCost) as unknown as Prisma.Decimal
    }

    state.quantity = nextQuantity
    resolved.push({ line, unitCost: unitCost.toString(), balanceAfter: nextQuantity })
  }

  const transaction = await tx.inventoryTransaction.create({
    data: {
      organizationId,
      type: input.type,
      occurredAt: input.occurredAt ?? new Date(),
      createdByUserId: input.createdByUserId ?? null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      reasonCode: input.reasonCode ?? null,
      notes: input.notes ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      reversalOfId: input.reversalOfId ?? null,
    },
    select: { id: true },
  })

  await tx.inventoryTransactionLine.createMany({
    data: resolved.map((r) => ({
      organizationId,
      transactionId: transaction.id,
      productId: r.line.productId,
      locationId: r.line.locationId,
      quantityDelta: r.line.quantityDelta,
      unitCost: r.unitCost,
      balanceAfter: r.balanceAfter,
      notes: r.line.notes ?? null,
    })),
  })

  const balances = new Map<string, number>()
  for (const [pair, state] of working) {
    const balance = locked.get(pair)!
    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: { quantity: state.quantity, avgUnitCost: state.avgUnitCost },
    })
    balances.set(pair, state.quantity)
  }

  return { transactionId: transaction.id, balances }
}

/**
 * Stock is moved, never conjured: the signed deltas of a transfer must sum to
 * zero per product (docs/02 §L2).
 */
function assertConservation(input: PostTransactionInput): void {
  if (!CONSERVING_TYPES.has(input.type)) return

  const byProduct = new Map<string, number>()
  for (const line of input.lines) {
    byProduct.set(line.productId, (byProduct.get(line.productId) ?? 0) + line.quantityDelta)
  }

  for (const [productId, net] of byProduct) {
    if (net !== 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `A ${input.type} must move stock, not create it: product ${productId} nets ${net > 0 ? '+' : ''}${net} base units.`,
      )
    }
  }
}

/**
 * Ensure the balance row exists and hold a row lock on it for the rest of the
 * transaction. The upsert-then-lock shape means two concurrent first-ever
 * postings for the same pair cannot race into a unique-constraint failure.
 */
async function lockBalance(
  tx: RawCapable,
  organizationId: string,
  locationId: string,
  productId: string,
): Promise<LockedBalance> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO inventory_balance (id, organization_id, location_id, product_id, quantity, avg_unit_cost, updated_at)
    VALUES (${createId()}, ${organizationId}, ${locationId}, ${productId}, 0, 0, NOW())
    ON CONFLICT (location_id, product_id) DO NOTHING
  `)

  const rows = await tx.$queryRaw<{ id: string; quantity: number; avg_unit_cost: string }[]>(
    Prisma.sql`
      SELECT id, quantity, avg_unit_cost
        FROM inventory_balance
       WHERE organization_id = ${organizationId}
         AND location_id = ${locationId}
         AND product_id = ${productId}
       FOR UPDATE
    `,
  )

  const row = rows[0]
  if (!row) {
    throw new AppError('INTERNAL', 'Inventory balance row vanished mid-transaction.')
  }

  return {
    id: row.id,
    quantity: Number(row.quantity),
    avgUnitCost: m(row.avg_unit_cost) as unknown as Prisma.Decimal,
  }
}

/**
 * Refuses to move stock out of a hold location (docs/02 §5b R7).
 *
 * Here rather than in each service, because this is the single write path: a
 * check in `transferStock` protects `transferStock`, and a check here protects
 * every caller that will ever exist, including the ones nobody has written yet.
 */
async function assertHoldsNotDrained(
  tx: RawCapable,
  organizationId: string,
  input: PostTransactionInput,
): Promise<void> {
  if (HOLD_RELEASING_TYPES.has(input.type)) return

  const sources = [
    ...new Set(input.lines.filter((l) => l.quantityDelta < 0).map((l) => l.locationId)),
  ]
  if (sources.length === 0) return

  const held = await tx.$queryRaw<{ name: string }[]>(Prisma.sql`
    SELECT name
      FROM inventory_location
     WHERE organization_id = ${organizationId}
       AND id IN (${Prisma.join(sources)})
       AND sellable = false
     LIMIT 1
  `)

  const location = held[0]
  if (!location) return

  throw new AppError(
    'CONFLICT',
    `${location.name} is a hold location. Stock cannot be moved out of it: ` +
      'goods held there are not sellable, and writing them off or returning ' +
      'them to the supplier is not something SnackLoad does yet.',
    { locationName: location.name },
  )
}

/**
 * The reconciliation from docs/02 §L6: the cache must equal the ledger. Used by
 * tests and exposed to admins as an integrity report.
 */
export async function findBalanceDrift(
  tx: RawCapable,
  organizationId: string,
): Promise<{ locationId: string; productId: string; balance: number; ledger: number }[]> {
  const rows = await tx.$queryRaw<
    { location_id: string; product_id: string; balance: number; ledger: number }[]
  >(Prisma.sql`
    SELECT b.location_id,
           b.product_id,
           b.quantity::int AS balance,
           COALESCE(l.total, 0)::int AS ledger
      FROM inventory_balance b
      LEFT JOIN (
            SELECT location_id, product_id, SUM(quantity_delta) AS total
              FROM inventory_transaction_line
             WHERE organization_id = ${organizationId}
             GROUP BY location_id, product_id
           ) l
        ON l.location_id = b.location_id AND l.product_id = b.product_id
     WHERE b.organization_id = ${organizationId}
       AND b.quantity <> COALESCE(l.total, 0)
  `)

  return rows.map((r) => ({
    locationId: r.location_id,
    productId: r.product_id,
    balance: Number(r.balance),
    ledger: Number(r.ledger),
  }))
}

/** Atomic document numbering (docs/02 §I3). Must run inside the writing transaction. */
export async function nextDocumentNumber(
  tx: SequenceTx,
  organizationId: string,
  docType: string,
): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string; prefix: string; next_number: number; pad_to: number }[]>(
    Prisma.sql`
      SELECT id, prefix, next_number, pad_to
        FROM document_sequence
       WHERE organization_id = ${organizationId} AND doc_type = ${docType}
       FOR UPDATE
    `,
  )

  const row = rows[0]
  if (!row) throw new AppError('INTERNAL', `No document sequence for ${docType}.`)

  await tx.documentSequence.update({
    where: { id: row.id },
    data: { nextNumber: Number(row.next_number) + 1 },
  })

  return `${row.prefix}${String(row.next_number).padStart(Number(row.pad_to), '0')}`
}
