import { Prisma } from '@/generated/prisma/client'
import type { AuthContext } from '@/server/auth/context'
import { m, toAmountString } from '@/server/domain/money'
import { findBalanceDrift } from '@/server/services/inventory.service'
import { unsafeDb } from '@/server/db/client'
import { describeFilters, reportQuery, resolveRange } from './filters'
import type { ReportColumn, ReportFilters, ReportResult, ReportRow } from './types'

/**
 * Inventory value and movement (spec §32).
 *
 * On-hand comes from `inventory_balance`, which is a cache of the ledger rather
 * than an independent set of books — and this report checks that claim rather
 * than assuming it. If any balance disagrees with the sum of its ledger lines,
 * the report says so at the top instead of quietly reporting a number nobody
 * can reconcile.
 *
 * Movement is read straight from `inventory_transaction_line`, because "how
 * much moved" is a question only the ledger can answer.
 */

type RawRow = {
  product_id: string
  name: string
  sku: string
  units_per_case: number
  on_hand: bigint | null
  held: bigint | null
  avg_unit_cost: string | null
  sold_units: bigint
  returned_sellable: bigint
  returned_unsellable: bigint
  received_units: bigint
  adjusted_units: bigint
  last_sold: Date | null
}

export async function runInventoryReport(
  ctx: AuthContext,
  filters: ReportFilters,
): Promise<ReportResult> {
  const timeZone = ctx.organization.timezone
  const range = resolveRange(filters, timeZone)

  const categoryFilter = filters.categoryId
    ? Prisma.sql`AND p.category_id = ${filters.categoryId}`
    : Prisma.empty
  const productFilter = filters.productId
    ? Prisma.sql`AND p.id = ${filters.productId}`
    : Prisma.empty

  const raw = await reportQuery<RawRow>(
    ctx,
    Prisma.sql`
      WITH balances AS (
        SELECT b.product_id,
               -- SELLABLE on-hand only. Goods sitting in a damaged, expired or
               -- supplier-return hold came back but cannot be sold, and adding
               -- them here would tell a runner they have stock they cannot
               -- load (spec §3).
               SUM(b.quantity) FILTER (WHERE loc.sellable)::bigint AS on_hand,
               SUM(b.quantity) FILTER (WHERE NOT loc.sellable)::bigint AS held,
               -- Weighted across locations: the same case is worth the same
               -- whether it is on a shelf or on a truck.
               CASE WHEN SUM(b.quantity) FILTER (WHERE loc.sellable) > 0
                    THEN SUM(b.avg_unit_cost * b.quantity) FILTER (WHERE loc.sellable)
                         / SUM(b.quantity) FILTER (WHERE loc.sellable)
                    ELSE MAX(b.avg_unit_cost)
               END AS avg_unit_cost
          FROM inventory_balance b
          JOIN inventory_location loc ON loc.id = b.location_id
         WHERE b.organization_id = ${ctx.organizationId}
         GROUP BY b.product_id
      ),
      movement AS (
        SELECT l.product_id,
               -- NET units sold. A sale takes stock off the truck; a customer
               -- return and the reversal written when a sale is voided put it
               -- back, and both have to come off this figure or a voided order
               -- shows up as volume that never left the building.
               COALESCE(SUM(
                 CASE WHEN t.type IN (
                             'SALE', 'CUSTOMER_RETURN',
                             'CUSTOMER_RETURN_SELLABLE', 'CUSTOMER_RETURN_DAMAGED',
                             'CUSTOMER_RETURN_EXPIRED', 'CUSTOMER_RETURN_SUPPLIER'
                           )
                        OR (t.type = 'REVERSAL' AND t.reference_type IN ('Sale', 'Return'))
                      THEN -l.quantity_delta ELSE 0 END
               ), 0)::bigint AS sold_units,
               -- Broken out rather than folded into an adjustment, so "what did
               -- stores give back, and in what state" is answerable (spec §15).
               COALESCE(SUM(
                 CASE WHEN t.type = 'CUSTOMER_RETURN_SELLABLE' THEN l.quantity_delta ELSE 0 END
               ), 0)::bigint AS returned_sellable,
               COALESCE(SUM(
                 CASE WHEN t.type IN ('CUSTOMER_RETURN_DAMAGED', 'CUSTOMER_RETURN_EXPIRED', 'CUSTOMER_RETURN_SUPPLIER')
                      THEN l.quantity_delta ELSE 0 END
               ), 0)::bigint AS returned_unsellable,
               COALESCE(SUM(
                 CASE WHEN t.type = 'SUPPLIER_RECEIPT' THEN l.quantity_delta ELSE 0 END
               ), 0)::bigint AS received_units,
               -- Shrinkage, damage and count corrections, netted together.
               COALESCE(SUM(
                 CASE WHEN t.type IN ('DAMAGE', 'EXPIRED', 'MISSING', 'SAMPLE', 'CORRECTION', 'COUNT_ADJUSTMENT')
                      THEN l.quantity_delta ELSE 0 END
               ), 0)::bigint AS adjusted_units,
               MAX(CASE WHEN t.type = 'SALE' THEN t.occurred_at END) AS last_sold
          FROM inventory_transaction_line l
          JOIN inventory_transaction t ON t.id = l.transaction_id
         WHERE l.organization_id = ${ctx.organizationId}
           AND t.occurred_at >= ${range.fromDate}
           AND t.occurred_at <= ${range.toDate}
         GROUP BY l.product_id
      )
      SELECT p.id AS product_id,
             p.name,
             p.sku,
             -- Packaging lives in ProductUom, never on the product row, so the
             -- case size is looked up rather than assumed (docs/01 rule 2).
             COALESCE(cs.base_units_per_uom, 1) AS units_per_case,
             COALESCE(b.on_hand, 0)::bigint AS on_hand,
             COALESCE(b.held, 0)::bigint AS held,
             COALESCE(b.avg_unit_cost, 0)::text AS avg_unit_cost,
             COALESCE(mv.sold_units, 0)::bigint AS sold_units,
             COALESCE(mv.returned_sellable, 0)::bigint AS returned_sellable,
             COALESCE(mv.returned_unsellable, 0)::bigint AS returned_unsellable,
             COALESCE(mv.received_units, 0)::bigint AS received_units,
             COALESCE(mv.adjusted_units, 0)::bigint AS adjusted_units,
             mv.last_sold
        FROM product p
        LEFT JOIN balances b ON b.product_id = p.id
        LEFT JOIN movement mv ON mv.product_id = p.id
        LEFT JOIN LATERAL (
              SELECT pu.base_units_per_uom
                FROM product_uom pu
               WHERE pu.product_id = p.id AND pu.code = 'CASE' AND pu.active = true
               ORDER BY pu.sort_order
               LIMIT 1
             ) cs ON true
       WHERE p.organization_id = ${ctx.organizationId}
         AND p.active = true
         ${categoryFilter}
         ${productFilter}
       ORDER BY COALESCE(b.on_hand, 0) * COALESCE(b.avg_unit_cost, 0) DESC
       LIMIT 1000
    `,
  )

  const days = Math.max(1, Math.round((range.toDate.getTime() - range.fromDate.getTime()) / 86_400_000))

  const rows: ReportRow[] = raw.map((row) => {
    const onHand = Number(row.on_hand)
    const cost = m(row.avg_unit_cost ?? '0')
    const sold = Number(row.sold_units)
    const perDay = sold / days

    return {
      label: row.name,
      sku: row.sku,
      onHand,
      onHandCases: row.units_per_case > 1 ? Math.floor(onHand / row.units_per_case) : onHand,
      held: Number(row.held ?? 0),
      unitCost: cost.toFixed(4),
      value: toAmountString(cost.times(onHand)),
      sold,
      returnedSellable: Number(row.returned_sellable),
      returnedUnsellable: Number(row.returned_unsellable),
      received: Number(row.received_units),
      adjusted: Number(row.adjusted_units),
      // Rounded up: half a day of cover is still a day you can sell through.
      daysOfCover: perDay > 0 ? Math.ceil(onHand / perDay) : null,
      lastSold: row.last_sold ? row.last_sold.toISOString() : null,
    }
  })

  const totals: ReportRow = {
    label: 'All products',
    sku: '',
    onHand: rows.reduce((n, r) => n + Number(r.onHand), 0),
    onHandCases: rows.reduce((n, r) => n + Number(r.onHandCases), 0),
    held: rows.reduce((n, r) => n + Number(r.held), 0),
    unitCost: '',
    value: toAmountString(rows.reduce((total, r) => total.plus(m(String(r.value))), m(0))),
    sold: rows.reduce((n, r) => n + Number(r.sold), 0),
    returnedSellable: rows.reduce((n, r) => n + Number(r.returnedSellable), 0),
    returnedUnsellable: rows.reduce((n, r) => n + Number(r.returnedUnsellable), 0),
    received: rows.reduce((n, r) => n + Number(r.received), 0),
    adjusted: rows.reduce((n, r) => n + Number(r.adjusted), 0),
    daysOfCover: null,
    lastSold: null,
  }

  const columns: ReportColumn[] = [
    { key: 'label', label: 'Product', format: 'text', primary: true },
    { key: 'sku', label: 'SKU', format: 'text' },
    { key: 'onHand', label: 'On hand', format: 'number', hint: 'Sellable base units' },
    { key: 'held', label: 'Held', format: 'number', hint: 'Returned, not sellable' },
    { key: 'unitCost', label: 'Unit cost', format: 'money', hint: 'Moving average' },
    { key: 'value', label: 'Value', format: 'money', primary: true },
    { key: 'sold', label: 'Sold', format: 'number', hint: 'Net of returns and voids' },
    { key: 'returnedSellable', label: 'Back (sellable)', format: 'number' },
    { key: 'returnedUnsellable', label: 'Back (write-off)', format: 'number' },
    { key: 'received', label: 'Received', format: 'number' },
    { key: 'adjusted', label: 'Adjusted', format: 'number', hint: 'Shrinkage, damage, counts' },
    { key: 'daysOfCover', label: 'Days of cover', format: 'number' },
    { key: 'lastSold', label: 'Last sold', format: 'date' },
  ]

  // The cache must equal the ledger. Say so, or say it does not.
  const drift = await findBalanceDrift(unsafeDb, ctx.organizationId)
  const notes = [
    'On hand is every SELLABLE location combined — warehouse and all trucks.',
    'Held is stock a store gave back that cannot be sold: damaged, expired or staged for the supplier. It is excluded from on hand and from value.',
    'Value is on-hand units at moving-average cost, not at what they will sell for.',
    'Days of cover extrapolates the selected window; a short window makes it jumpy.',
    'Adjusted is net: a positive count correction and a damaged case cancel each other here.',
  ]
  if (drift.length > 0) {
    notes.unshift(
      `⚠ ${drift.length} balance ${drift.length === 1 ? 'row does' : 'rows do'} not match the ledger. ` +
        'These figures cannot be reconciled until that is resolved.',
    )
  }

  return {
    key: 'inventory',
    title: 'Inventory value and movement',
    definition:
      'On hand is the current SELLABLE balance across warehouses and trucks, in ' +
      'base units, taken now rather than as of the end of the window. Held is ' +
      'stock that came back from a store and cannot be sold — damaged, expired ' +
      'or staged for return to the supplier — counted separately so it never ' +
      'looks like stock a runner could load. Value is on-hand units at the ' +
      'moving-average cost of the goods: what they cost to buy, not what they ' +
      'will sell for. Sold is net units that left on a sale, less everything ' +
      'customers returned and less the reversals written when a sale or a return ' +
      'is voided. Back (sellable) and Back (write-off) split those returns by ' +
      'what happened to the goods. Received is supplier receipts. Adjusted is ' +
      'damage, expiry, missing stock, samples and count corrections found in our ' +
      'own inventory, netted together. Truck loads and transfers move stock ' +
      'between locations without changing any of these. Days of cover is on-hand ' +
      'divided by the average daily units sold during the window.',
    columns,
    rows,
    totals,
    notes,
    filters: { ...filters, from: range.from, to: range.to },
    appliedTo: await describeFilters(ctx, filters, range),
    currency: ctx.organization.currency,
    timeZone,
    generatedAt: new Date().toISOString(),
  }
}
