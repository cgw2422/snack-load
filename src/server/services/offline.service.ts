import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { m, toAmountString } from '@/server/domain/money'
import { resolveSellingLocation } from './sale.service'
import { getRunnerDay, type RunnerDay } from './routerun.service'
import type {
  BalanceSnapshot,
  CatalogItem,
  CatalogSnapshot,
} from '@/lib/offline/types'

/**
 * What a phone is allowed to keep when the signal goes (docs/05 §2).
 *
 * Three reads, deliberately separated because they age at different rates and
 * so are cached under different strategies:
 *
 * | Read | Ages | Strategy |
 * |---|---|---|
 * | `getRouteDay` | slowly — the stop list is settled at dispatch | stale-while-revalidate |
 * | `getTruckCatalog` | slowly — names, units, list prices | stale-while-revalidate |
 * | `getTruckBalances` | every sale | network-first, shown with its age |
 *
 * Every snapshot carries `asOf`. A cached balance rendered as though it were
 * live is worse than no balance at all, so the figure and its age always travel
 * together and the UI is required to show both.
 *
 * None of this is authority. The server prices, decrements and numbers every
 * document on arrival; a snapshot only tells the runner what to expect.
 */

export type Snapshot<T> = T & {
  /** When the server produced this, ISO-8601. The client labels figures with it. */
  asOf: string
}

export async function getRouteDay(ctx: AuthContext): Promise<Snapshot<RunnerDay>> {
  const day = await getRunnerDay(ctx)
  return { ...day, asOf: new Date().toISOString() }
}

export type { BalanceSnapshot, CatalogItem, CatalogSnapshot }

/**
 * The catalogue subset that is actually on the truck.
 *
 * Not the whole product list: a runner cannot sell what they are not carrying,
 * and a 4,000-row catalogue is not something to push over 3G. Prices here are
 * list prices for display only — customer and price-group overrides are
 * resolved server-side at checkout, where they belong.
 */
export async function getTruckCatalog(ctx: AuthContext): Promise<CatalogSnapshot> {
  requirePermission(ctx, 'product:read')
  const prisma = db(ctx)
  const location = await resolveSellingLocation(ctx)

  const balances = await prisma.inventoryBalance.findMany({
    where: { locationId: location.id, quantity: { not: 0 } },
    orderBy: { product: { name: 'asc' } },
    select: {
      product: {
        select: {
          id: true, sku: true, name: true, brand: true, baseUomLabel: true,
          taxable: true, active: true,
          uoms: {
            where: { active: true },
            orderBy: { baseUnitsPerUom: 'asc' },
            select: {
              id: true, label: true, baseUnitsPerUom: true, price: true,
              isDefaultSaleUom: true,
            },
          },
        },
      },
    },
  })

  return {
    locationId: location.id,
    locationName: location.name,
    asOf: new Date().toISOString(),
    items: balances
      .filter((balance) => balance.product.active)
      .map((balance) => ({
        productId: balance.product.id,
        sku: balance.product.sku,
        name: balance.product.name,
        brand: balance.product.brand,
        baseUomLabel: balance.product.baseUomLabel,
        taxable: balance.product.taxable,
        uoms: balance.product.uoms.map((uom) => ({
          id: uom.id,
          label: uom.label,
          baseUnitsPerUom: uom.baseUnitsPerUom,
          price: toAmountString(m(uom.price)),
          isDefaultSaleUom: uom.isDefaultSaleUom,
        })),
      })),
  }
}

/**
 * What is on the truck right now, in base units.
 *
 * Quantities only. They move with every sale, so this is the one read the
 * client refuses to serve from cache without saying how old it is.
 */
export async function getTruckBalances(ctx: AuthContext): Promise<BalanceSnapshot> {
  requirePermission(ctx, 'inventory:read')
  const prisma = db(ctx)
  const location = await resolveSellingLocation(ctx)

  const balances = await prisma.inventoryBalance.findMany({
    where: { locationId: location.id, quantity: { not: 0 } },
    orderBy: { product: { name: 'asc' } },
    select: { productId: true, quantity: true },
  })

  return {
    locationId: location.id,
    locationName: location.name,
    asOf: new Date().toISOString(),
    balances: balances.map((balance) => ({
      productId: balance.productId,
      quantity: balance.quantity,
    })),
  }
}
