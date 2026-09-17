import 'dotenv/config'
import { unsafeDb } from '../../src/server/db/client'
import { hashPassword } from '../../src/server/auth/password'
import {
  seedDocumentSequences,
  seedPrimaryWarehouse,
  seedRoles,
} from '../../src/server/services/provisioning'
import {
  findBalanceDrift,
  nextDocumentNumber,
  postInventoryTransaction,
} from '../../src/server/services/inventory.service'
import { computeSaleTotals, assertTotalsIdentity, dueDateFor } from '../../src/server/domain/saleMath'
import { m, round2, round6, toAmountString } from '../../src/server/domain/money'
import { dateOnly, localDateString } from '../../src/lib/dates'
import { slugify } from '../../src/lib/slug'
import { CUSTOMERS, DEMO_PASSWORD, PRODUCTS, ROUTES, SUPPLIERS, TEAM, VEHICLES } from './data'

/**
 * Demo organization (spec §50).
 *
 * Everything here goes through the same code paths the app uses — the ledger
 * engine posts the stock, the domain layer computes the totals, document numbers
 * come from the locked sequence. A seeder that wrote balances directly would
 * produce data the real app could never have produced, and would hide exactly
 * the bugs this data exists to surface. The run ends by asserting that the
 * balance cache still equals the ledger.
 */

const ORG_NAME = 'Valley Snack Distributors'
const TIMEZONE = 'America/New_York'
const TAX_RATE = '0.0725'

/** Deterministic PRNG, so two seed runs produce the same history. */
function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const random = rng(20260916)

function pick<T>(items: T[], count: number): T[] {
  const pool = [...items]
  const out: T[] = []
  for (let i = 0; i < count && pool.length > 0; i++) {
    out.push(pool.splice(Math.floor(random() * pool.length), 1)[0])
  }
  return out
}

/**
 * A fixed hour of the day, n days back.
 *
 * Today is clamped to at least an hour ago. Without that, seeding before the
 * anchor hour puts today's route in the future, the loop skips it, and whether
 * the demo has a truck loaded and a route in progress depends on the minute you
 * happened to run `pnpm db:seed`. The calendar day is preserved either way.
 */
function daysAgo(n: number): Date {
  const now = new Date()
  const d = new Date(now)
  d.setUTCHours(15, 30, 0, 0)

  if (n === 0) {
    const justAfterMidnight = new Date(now)
    justAfterMidnight.setUTCHours(0, 1, 0, 0)
    d.setTime(
      Math.max(
        justAfterMidnight.getTime(),
        Math.min(d.getTime(), now.getTime() - 60 * 60 * 1000),
      ),
    )
  }

  d.setUTCDate(d.getUTCDate() - n)
  return d
}

/** A plausible, deliberately undeliverable address for a demo store. */
function storeEmail(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24)
  return `orders@${slug || 'store'}.demo`
}

const WEEKDAY_INDEX: Record<string, number> = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
}

/** The most recent occurrence of `dayOfWeek` on or before today, less N weeks. */
function serviceDay(dayOfWeek: string, weeksAgo: number): Date {
  const today = new Date()
  const back = (today.getUTCDay() - WEEKDAY_INDEX[dayOfWeek] + 7) % 7
  return daysAgo(back + weeksAgo * 7)
}

async function main() {
  console.log('Seeding SnackLoad demo data…\n')

  const slug = slugify(ORG_NAME)
  const existing = await unsafeDb.organization.findUnique({ where: { slug }, select: { id: true } })
  if (existing) {
    console.log('  Removing the previous demo organization…')
    await unsafeDb.organization.delete({ where: { id: existing.id } })
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD)

  // ── Organization, roles, warehouse ────────────────────────────────────────
  const org = await unsafeDb.organization.create({
    data: {
      name: ORG_NAME,
      slug,
      legalName: 'Valley Snack Distributors LLC',
      email: 'office@valleysnack.demo',
      phone: '(555) 200-0100',
      addressLine1: '1420 Industrial Pkwy',
      city: 'Sandusky',
      state: 'OH',
      postalCode: '44870',
      timezone: TIMEZONE,
      receiptFooter: 'Thanks for your business! Questions? (555) 200-0100',
      // The demo company is past setup; only the optional QuickBooks step is open.
      onboardingJson: {
        company: true, products: true, customers: true, team: true, vehicles: true,
        routes: true, inventory: true, quickbooks: false, first_route: true,
      },
      settings: { allowNegativeTruckStock: false },
    },
    select: { id: true },
  })
  const organizationId = org.id

  const roleIds = await unsafeDb.$transaction(async (tx) => {
    const ids = await seedRoles(tx, organizationId)
    await seedDocumentSequences(tx, organizationId)
    return ids
  })

  const { warehouseId: mainWarehouseId, locationId: warehouseLocationId } = await seedPrimaryWarehouse(
    unsafeDb,
    organizationId,
    'Main Warehouse',
  )

  // The depot the trucks leave from — route optimisation starts here.
  await unsafeDb.warehouse.update({
    where: { id: mainWarehouseId },
    data: {
      addressLine1: '1420 Industrial Pkwy',
      city: 'Sandusky',
      state: 'OH',
      postalCode: '44870',
      latitude: '41.437300',
      longitude: '-82.672700',
    },
  })

  const taxRate = await unsafeDb.taxRate.create({
    data: { organizationId, name: 'Ohio 7.25%', rate: TAX_RATE, isDefault: true },
    select: { id: true },
  })
  console.log(`  Organization: ${ORG_NAME}`)

  // ── Team ──────────────────────────────────────────────────────────────────
  const usersByEmail = new Map<string, string>()
  for (const person of TEAM) {
    const user = await unsafeDb.user.upsert({
      where: { email: person.email },
      update: { firstName: person.firstName, lastName: person.lastName, passwordHash },
      create: {
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        phone: person.phone,
        passwordHash,
        lastLoginAt: daysAgo(Math.floor(random() * 3)),
      },
      select: { id: true },
    })
    usersByEmail.set(person.email, user.id)
    await unsafeDb.membership.create({
      data: { organizationId, userId: user.id, roleId: roleIds[person.role] },
    })
  }
  console.log(`  Team: ${TEAM.length} people`)

  // ── Vehicles ──────────────────────────────────────────────────────────────
  const vehiclesByNumber = new Map<string, { id: string; locationId: string }>()
  for (const v of VEHICLES) {
    const location = await unsafeDb.inventoryLocation.create({
      data: { organizationId, kind: 'VEHICLE', name: v.name, code: `T${v.truckNumber}` },
      select: { id: true },
    })
    const vehicle = await unsafeDb.vehicle.create({
      data: {
        organizationId,
        locationId: location.id,
        name: v.name,
        truckNumber: v.truckNumber,
        licensePlate: v.licensePlate,
        assignedUserId: usersByEmail.get(v.runnerEmail)!,
      },
      select: { id: true },
    })
    vehiclesByNumber.set(v.truckNumber, { id: vehicle.id, locationId: location.id })
    await unsafeDb.membership.updateMany({
      where: { organizationId, userId: usersByEmail.get(v.runnerEmail)! },
      data: { defaultVehicleId: vehicle.id },
    })
  }
  console.log(`  Vehicles: ${VEHICLES.length} trucks`)

  // ── Suppliers & categories ────────────────────────────────────────────────
  const supplierIds = new Map<string, string>()
  for (const s of SUPPLIERS) {
    const supplier = await unsafeDb.supplier.create({
      data: { organizationId, ...s },
      select: { id: true },
    })
    supplierIds.set(s.name, supplier.id)
  }

  const categoryIds = new Map<string, string>()
  for (const [index, name] of ['Chips', 'Candy', 'Drinks', 'Energy'].entries()) {
    const category = await unsafeDb.productCategory.create({
      data: { organizationId, name, sortOrder: index },
      select: { id: true },
    })
    categoryIds.set(name, category.id)
  }

  // ── Products ──────────────────────────────────────────────────────────────
  type ProductRef = {
    id: string
    name: string
    sku: string
    taxable: boolean
    unitsPerCase: number
    baseUomId: string
    caseUomId: string
    caseLabel: string
    casePrice: string
    unitPrice: string
    costPerBaseUnit: string
  }
  const products: ProductRef[] = []

  for (const p of PRODUCTS) {
    const costPerBaseUnit = round6(m(p.caseCost).dividedBy(p.unitsPerCase))
    const product = await unsafeDb.product.create({
      data: {
        organizationId,
        sku: p.sku,
        upc: p.upc,
        name: p.name,
        brand: p.brand,
        categoryId: categoryIds.get(p.category)!,
        supplierId: supplierIds.get(p.supplier)!,
        baseUomLabel: p.baseUomLabel,
        costPerBaseUnit: costPerBaseUnit.toString(),
        reorderPointBaseUnits: p.reorderCases * p.unitsPerCase,
        taxable: p.taxable ?? true,
        description: `${p.brand} · ${p.unitsPerCase} ${p.baseUomLabel.toLowerCase()} per case`,
      },
      select: { id: true },
    })

    const baseUom = await unsafeDb.productUom.create({
      data: {
        organizationId,
        productId: product.id,
        code: 'EACH',
        label: p.baseUomLabel,
        baseUnitsPerUom: 1,
        price: p.unitPrice.toString(),
        isBase: true,
        sortOrder: 0,
      },
      select: { id: true },
    })

    const caseCode = p.caseLabel ?? 'CASE'
    const caseUom = await unsafeDb.productUom.create({
      data: {
        organizationId,
        productId: product.id,
        code: caseCode,
        label: caseCode === 'CASE' ? 'Case' : caseCode.charAt(0) + caseCode.slice(1).toLowerCase(),
        baseUnitsPerUom: p.unitsPerCase,
        price: p.casePrice.toString(),
        barcode: p.upc,
        isDefaultSaleUom: true,
        sortOrder: 1,
      },
      select: { id: true, label: true },
    })

    products.push({
      id: product.id,
      name: p.name,
      sku: p.sku,
      taxable: p.taxable ?? true,
      unitsPerCase: p.unitsPerCase,
      baseUomId: baseUom.id,
      caseUomId: caseUom.id,
      caseLabel: caseUom.label,
      casePrice: p.casePrice.toString(),
      unitPrice: p.unitPrice.toString(),
      costPerBaseUnit: costPerBaseUnit.toString(),
    })
  }
  console.log(`  Products: ${products.length}`)

  // ── Route templates ───────────────────────────────────────────────────────
  const routeTemplates = new Map<string, { id: string; runnerUserId: string; vehicleId: string; locationId: string }>()
  for (const r of ROUTES) {
    const vehicle = vehiclesByNumber.get(r.truckNumber)!
    const runnerUserId = usersByEmail.get(r.runnerEmail)!
    const template = await unsafeDb.routeTemplate.create({
      data: {
        organizationId,
        name: r.name,
        code: r.code,
        color: r.color,
        dayOfWeek: r.dayOfWeek,
        defaultRunnerUserId: runnerUserId,
        defaultVehicleId: vehicle.id,
      },
      select: { id: true },
    })
    routeTemplates.set(r.name, {
      id: template.id,
      runnerUserId,
      vehicleId: vehicle.id,
      locationId: vehicle.locationId,
    })
  }

  // ── Customers & schedules ─────────────────────────────────────────────────
  type CustomerRef = (typeof CUSTOMERS)[number] & { id: string }
  const customers: CustomerRef[] = []

  for (const c of CUSTOMERS) {
    const template = routeTemplates.get(c.route)!
    const customer = await unsafeDb.customer.create({
      data: {
        organizationId,
        accountNumber: c.accountNumber,
        name: c.name,
        parentCompany: c.parentCompany ?? null,
        addressLine1: c.addressLine1,
        city: c.city,
        state: c.state,
        postalCode: c.postalCode,
        latitude: c.latitude.toString(),
        longitude: c.longitude.toString(),
        phone: c.phone,
        // Every store has an address on file so the receipt-delivery workflow
        // has something to demonstrate. `.demo` is reserved and unroutable, so
        // a misconfigured provider cannot mail a stranger.
        email: storeEmail(c.name),
        paymentTermsCode: c.terms,
        creditLimit: c.creditLimit?.toString() ?? null,
        taxRateId: taxRate.id,
        notes: c.notes ?? null,
        contacts: {
          create: {
            organizationId,
            name: c.contactName,
            phone: c.phone,
            email: storeEmail(c.name),
            isPrimary: true,
          },
        },
        schedules: {
          create: {
            organizationId,
            routeTemplateId: template.id,
            frequency: 'WEEKLY',
            dayOfWeek: ROUTES.find((r) => r.name === c.route)!.dayOfWeek,
            sequence: c.sequence,
            windowStart: '07:00',
            windowEnd: '12:00',
          },
        },
      },
      select: { id: true },
    })
    customers.push({ ...c, id: customer.id })
  }
  console.log(`  Customers: ${customers.length} stores`)

  // ── Opening stock: two supplier receipts into the warehouse ───────────────
  const warehouseId = usersByEmail.get('dana@snackload.demo')!

  await unsafeDb.$transaction(async (tx) => {
    const reference = await nextDocumentNumber(tx, organizationId, 'RECEIVING')
    const posted = await postInventoryTransaction(tx, organizationId, {
      type: 'SUPPLIER_RECEIPT',
      occurredAt: daysAgo(21),
      createdByUserId: warehouseId,
      referenceType: 'Receiving',
      notes: `Opening stock ${reference}`,
      lines: products.map((p) => ({
        productId: p.id,
        locationId: warehouseLocationId,
        // Enough to supply three routes, plus a partial case so the
        // "18 cs 7 ea" display path is exercised by real data.
        quantityDelta: p.unitsPerCase * 90 + 7,
        unitCost: p.costPerBaseUnit,
      })),
    })
    await tx.inventoryTransaction.update({
      where: { id: posted.transactionId },
      data: { referenceId: posted.transactionId },
    })
  })
  console.log('  Opening stock received into Main Warehouse')

  // ── Historical routes and sales, eight weeks back ─────────────────────────
  let saleCount = 0
  let paymentCount = 0

  for (let weeksAgo = 8; weeksAgo >= 0; weeksAgo--) {
    // A distributor reorders every week; without this the warehouse would simply
    // run dry, and the ledger would (correctly) refuse to keep loading trucks.
    if (weeksAgo < 8) {
      await unsafeDb.$transaction(async (tx) => {
        await postInventoryTransaction(tx, organizationId, {
          type: 'SUPPLIER_RECEIPT',
          occurredAt: daysAgo(weeksAgo * 7 + 4),
          createdByUserId: warehouseId,
          referenceType: 'Receiving',
          notes:
            weeksAgo <= 2
              ? 'Weekly replenishment — Takis short-shipped (Barcel backorder)'
              : 'Weekly replenishment',
          lines: products
            // Barcel has been short-shipping Takis for three weeks. It is the
            // fastest mover, so this is what puts a product genuinely below its
            // reorder point rather than a number nudged to make a screenshot.
            .filter((p) => !(weeksAgo <= 2 && p.sku === '1001'))
            .map((p) => ({
              productId: p.id,
              locationId: warehouseLocationId,
              quantityDelta: p.unitsPerCase * 16,
              unitCost: p.costPerBaseUnit,
            })),
        })
      })
    }

    for (const routeSeed of ROUTES) {
      const template = routeTemplates.get(routeSeed.name)!
      const routeCustomers = customers.filter((c) => c.route === routeSeed.name)

      const when = serviceDay(routeSeed.dayOfWeek, weeksAgo)
      if (when.getTime() > Date.now()) continue

      const serviceDate = dateOnly(localDateString(when, TIMEZONE))
      const isToday = weeksAgo === 0 && localDateString(when, TIMEZONE) === localDateString(new Date(), TIMEZONE)

      // The truck carries the whole catalog — a runner cannot sell what was not
      // loaded, and the ledger enforces that. When the warehouse is short (see
      // the Takis backorder above) the truck takes what is on the shelf, which
      // is what a warehouse actually does.
      const warehouseStock = new Map(
        (
          await unsafeDb.inventoryBalance.findMany({
            where: { organizationId, locationId: warehouseLocationId },
            select: { productId: true, quantity: true },
          })
        ).map((b) => [b.productId, b.quantity]),
      )

      const loadLines = products
        .map((p) => {
          const wanted = (16 + Math.floor(random() * 5)) * p.unitsPerCase
          const available = warehouseStock.get(p.id) ?? 0
          return { product: p, quantity: Math.min(wanted, available) }
        })
        .filter((l) => l.quantity > 0)

      await unsafeDb.$transaction(async (tx) => {
        await postInventoryTransaction(tx, organizationId, {
          type: 'TRUCK_LOAD',
          occurredAt: new Date(when.getTime() - 3 * 60 * 60 * 1000),
          createdByUserId: warehouseId,
          referenceType: 'TruckLoad',
          lines: loadLines.flatMap(({ product, quantity }) => [
            { productId: product.id, locationId: warehouseLocationId, quantityDelta: -quantity },
            { productId: product.id, locationId: template.locationId, quantityDelta: quantity },
          ]),
        })
      })

      const route = await unsafeDb.route.create({
        data: {
          organizationId,
          routeTemplateId: template.id,
          serviceDate,
          name: routeSeed.name,
          runnerUserId: template.runnerUserId,
          vehicleId: template.vehicleId,
          status: weeksAgo === 0 && isToday ? 'IN_PROGRESS' : 'COMPLETED',
          startedAt: new Date(when.getTime() - 60 * 60 * 1000),
          completedAt: weeksAgo === 0 && isToday ? null : new Date(when.getTime() + 5 * 60 * 60 * 1000),
          plannedStops: routeCustomers.length,
          plannedMiles: (18 + random() * 30).toFixed(2),
          plannedMinutes: 240 + Math.floor(random() * 120),
          stops: {
            create: routeCustomers.map((c, index) => ({
              organizationId,
              customerId: c.id,
              sequence: index + 1,
              status: 'PENDING' as const,
              distanceMiles: (1.5 + random() * 5).toFixed(2),
              durationMinutes: 5 + Math.floor(random() * 10),
            })),
          },
        },
        select: { id: true, stops: { select: { id: true, customerId: true, sequence: true } } },
      })

      // On today's in-progress route, leave the later stops genuinely pending so
      // the runner dashboard has a real "next stop" to show.
      const completeThrough = isToday
        ? Math.max(1, Math.floor(routeCustomers.length * 0.4))
        : routeCustomers.length

      for (const stop of route.stops.sort((a, b) => a.sequence - b.sequence)) {
        if (stop.sequence > completeThrough) continue

        const customer = customers.find((c) => c.id === stop.customerId)!
        const trend = weeksAgo <= 2 ? (customer.recentTrend ?? 1) : 1
        const budget = customer.typicalOrder * trend * (0.82 + random() * 0.36)

        const sellable = products.filter((p) =>
          loadLines.some((l) => l.product.id === p.id),
        )

        const result = await createSale({
          organizationId,
          customer,
          products: sellable,
          budget,
          occurredAt: new Date(when.getTime() + stop.sequence * 45 * 60 * 1000),
          sellerId: template.runnerUserId,
          routeId: route.id,
          routeStopId: stop.id,
          sellingLocationId: template.locationId,
          taxRate: TAX_RATE,
          weeksAgo,
        })

        if (result) {
          saleCount += 1
          if (result.paid) paymentCount += 1
        }

        await unsafeDb.routeStop.update({
          where: { id: stop.id },
          data: {
            status: result ? 'COMPLETED' : 'NO_SALE',
            arrivedAt: new Date(when.getTime() + stop.sequence * 45 * 60 * 1000),
            completedAt: new Date(when.getTime() + stop.sequence * 45 * 60 * 1000 + 12 * 60 * 1000),
            outcomeReason: result ? null : 'Overstocked from last week',
          },
        })

        await unsafeDb.customer.update({
          where: { id: customer.id },
          data: { lastVisitAt: when },
        })
      }

      if (!isToday) {
        await unloadTruck(
          organizationId,
          template.locationId,
          warehouseLocationId,
          new Date(when.getTime() + 7 * 60 * 60 * 1000),
          warehouseId,
        )
      }
    }
  }

  console.log(`  Sales: ${saleCount} · Payments: ${paymentCount}`)

  // ── Shrinkage: damage and expiry happen, and the ledger records them ──────
  const shrinkage: { sku: string; type: 'DAMAGE' | 'EXPIRED'; cases: number; reason: string }[] = [
    { sku: '1001', type: 'DAMAGE', cases: 3, reason: 'Pallet dropped on the dock' },
    { sku: '1006', type: 'EXPIRED', cases: 2, reason: 'Past best-by date' },
  ]

  for (const entry of shrinkage) {
    const product = products.find((p) => p.sku === entry.sku)!
    const warehouse = await unsafeDb.inventoryBalance.findFirst({
      where: { organizationId, productId: product.id, locationId: warehouseLocationId },
      select: { quantity: true },
    })
    const writeOff = Math.min(warehouse?.quantity ?? 0, entry.cases * product.unitsPerCase)
    if (writeOff <= 0) continue

    await unsafeDb.$transaction(async (tx) => {
      await postInventoryTransaction(tx, organizationId, {
        type: entry.type,
        occurredAt: daysAgo(2),
        createdByUserId: warehouseId,
        reasonCode: entry.type,
        notes: entry.reason,
        lines: [
          { productId: product.id, locationId: warehouseLocationId, quantityDelta: -writeOff },
        ],
      })
    })
  }

  // ── A few notifications and a low-stock nudge ─────────────────────────────
  await unsafeDb.notification.createMany({
    data: [
      {
        organizationId,
        type: 'low_stock',
        severity: 'WARNING',
        title: 'Takis Fuego is below its reorder point',
        body: 'Main Warehouse is running low. Consider reordering from Barcel USA.',
      },
      {
        organizationId,
        type: 'account_overdue',
        severity: 'WARNING',
        title: 'BellStores is past due',
        body: 'An invoice on NET30 terms has passed its due date.',
      },
      {
        organizationId,
        type: 'quickbooks',
        severity: 'INFO',
        title: 'QuickBooks is not connected',
        body: 'Connect QuickBooks Online to sync invoices and payments.',
      },
    ],
  })

  // ── Integrity check: the cache must equal the ledger (docs/02 §L6) ─────────
  const drift = await findBalanceDrift(unsafeDb, organizationId)
  if (drift.length > 0) {
    console.error('\n  Balance drift detected:', drift)
    throw new Error('Seed produced inventory balances that disagree with the ledger.')
  }

  const [balanceCount, ledgerCount] = await Promise.all([
    unsafeDb.inventoryBalance.count({ where: { organizationId } }),
    unsafeDb.inventoryTransactionLine.count({ where: { organizationId } }),
  ])

  console.log(`\n  Ledger: ${ledgerCount} lines across ${balanceCount} balances — reconciled ✓`)
  console.log('\nDone. Sign in with:')
  for (const person of TEAM) {
    console.log(`  ${person.email.padEnd(24)} ${DEMO_PASSWORD}   (${person.role})`)
  }
}

/**
 * Return whatever came back from the route to the warehouse. Truck stock may
 * legitimately stay on board overnight, so this is a choice the seed makes for
 * completed runs only — today's truck keeps its load.
 */
async function unloadTruck(
  organizationId: string,
  truckLocationId: string,
  warehouseLocationId: string,
  occurredAt: Date,
  userId: string,
) {
  const onBoard = await unsafeDb.inventoryBalance.findMany({
    where: { organizationId, locationId: truckLocationId, quantity: { gt: 0 } },
    select: { productId: true, quantity: true },
  })
  if (onBoard.length === 0) return

  await unsafeDb.$transaction(async (tx) => {
    await postInventoryTransaction(tx, organizationId, {
      type: 'TRUCK_UNLOAD',
      occurredAt,
      createdByUserId: userId,
      referenceType: 'TruckLoad',
      notes: 'End-of-route unload',
      lines: onBoard.flatMap((b) => [
        { productId: b.productId, locationId: truckLocationId, quantityDelta: -b.quantity },
        { productId: b.productId, locationId: warehouseLocationId, quantityDelta: b.quantity },
      ]),
    })
  })
}

/** Builds one realistic sale, posting stock and money exactly as the app would. */
async function createSale(args: {
  organizationId: string
  customer: { id: string; name: string; terms: string; typicalOrder: number }
  products: {
    id: string; name: string; sku: string; taxable: boolean; unitsPerCase: number
    caseUomId: string; caseLabel: string; casePrice: string; costPerBaseUnit: string
  }[]
  budget: number
  occurredAt: Date
  sellerId: string
  routeId: string
  routeStopId: string
  sellingLocationId: string
  taxRate: string
  weeksAgo: number
}) {
  // Bigger accounts buy across more of the catalog, not more of one thing.
  const lineCount = Math.min(7, 3 + Math.floor(args.budget / 140))
  const chosen = pick(args.products, lineCount)

  const lines = chosen
    .map((product) => {
      const casePrice = Number(product.casePrice)
      const target = (args.budget / chosen.length / casePrice) * (0.7 + random() * 0.6)
      // A convenience store takes a few cases, never twenty.
      const quantity = Math.min(7, Math.max(1, Math.round(target)))
      return { product, quantity }
    })
    .filter((l) => l.quantity > 0)

  if (lines.length === 0) return null

  const totals = computeSaleTotals({
    lines: lines.map((l) => ({
      quantity: l.quantity,
      baseUnitsPerUom: l.product.unitsPerCase,
      unitPrice: l.product.casePrice,
      taxable: l.product.taxable,
    })),
    taxRate: args.taxRate,
    taxExempt: false,
  })
  assertTotalsIdentity(totals)

  // COD is settled at the stop; terms accounts sometimes pay later, sometimes part.
  const isCod = args.customer.terms === 'COD'
  const payFully = isCod || random() > 0.45
  const payPartly = !payFully && random() > 0.5

  const amountPaid = payFully
    ? totals.total
    : payPartly
      ? round2(totals.total.times(0.4))
      : m(0)

  return unsafeDb.$transaction(async (tx) => {
    const saleNumber = await nextDocumentNumber(tx, args.organizationId, 'SALE')
    const receiptNumber = await nextDocumentNumber(tx, args.organizationId, 'RECEIPT')

    const posted = await postInventoryTransaction(tx, args.organizationId, {
      type: 'SALE',
      occurredAt: args.occurredAt,
      createdByUserId: args.sellerId,
      referenceType: 'Sale',
      lines: lines.map((l) => ({
        productId: l.product.id,
        locationId: args.sellingLocationId,
        quantityDelta: -(l.quantity * l.product.unitsPerCase),
      })),
    })

    const sale = await tx.sale.create({
      data: {
        organizationId: args.organizationId,
        saleNumber,
        customerId: args.customer.id,
        routeId: args.routeId,
        routeStopId: args.routeStopId,
        soldByUserId: args.sellerId,
        status: 'COMPLETED',
        occurredAt: args.occurredAt,
        subtotal: totals.subtotal.toString(),
        discountTotal: totals.discountTotal.toString(),
        taxTotal: totals.taxTotal.toString(),
        total: totals.total.toString(),
        amountPaid: amountPaid.toString(),
        balanceDue: totals.total.minus(amountPaid).toString(),
        dueDate: dueDateFor(args.occurredAt, args.customer.terms),
        paymentTermsCode: args.customer.terms as 'COD' | 'NET7' | 'NET15' | 'NET30',
        idempotencyKey: `seed-sale-${saleNumber}`,
        inventoryTransactionId: posted.transactionId,
        items: {
          create: lines.map((l, index) => {
            const computed = totals.lines[index]
            return {
              organizationId: args.organizationId,
              productId: l.product.id,
              productUomId: l.product.caseUomId,
              productNameSnapshot: l.product.name,
              skuSnapshot: l.product.sku,
              uomLabelSnapshot: l.product.caseLabel,
              quantity: l.quantity,
              baseQuantity: computed.baseQuantity,
              unitPrice: computed.unitPrice.toString(),
              lineSubtotal: computed.lineSubtotal.toString(),
              discountAmount: computed.discountAmount.toString(),
              taxAmount: computed.taxAmount.toString(),
              lineTotal: computed.lineTotal.toString(),
              unitCostAtSale: l.product.costPerBaseUnit,
              sortOrder: index,
            }
          }),
        },
        receipt: {
          create: { organizationId: args.organizationId, receiptNumber, issuedAt: args.occurredAt },
        },
      },
      select: { id: true },
    })

    if (amountPaid.greaterThan(0)) {
      const payment = await tx.payment.create({
        data: {
          organizationId: args.organizationId,
          customerId: args.customer.id,
          method: isCod ? (random() > 0.75 ? 'CHECK' : 'CASH') : random() > 0.5 ? 'CHECK' : 'CASH',
          amount: amountPaid.toString(),
          unappliedAmount: '0',
          receivedAt: args.occurredAt,
          receivedByUserId: args.sellerId,
          routeStopId: args.routeStopId,
          idempotencyKey: `seed-pay-${saleNumber}`,
        },
        select: { id: true },
      })
      await tx.paymentAllocation.create({
        data: {
          organizationId: args.organizationId,
          paymentId: payment.id,
          saleId: sale.id,
          amount: amountPaid.toString(),
        },
      })
    }

    // Customer.balance is a cache of open sale balances (docs/02 §A2).
    const outstanding = totals.total.minus(amountPaid)
    if (outstanding.greaterThan(0)) {
      await tx.customer.update({
        where: { id: args.customer.id },
        data: { balance: { increment: outstanding.toString() } },
      })
    }

    await tx.auditLog.create({
      data: {
        organizationId: args.organizationId,
        userId: args.sellerId,
        action: 'sale.completed',
        entityType: 'Sale',
        entityId: sale.id,
        afterJson: {
          saleNumber,
          customerName: args.customer.name,
          total: toAmountString(totals.total),
        },
        createdAt: args.occurredAt,
      },
    })

    return { saleId: sale.id, paid: amountPaid.greaterThan(0) }
  })
}

main()
  .then(() => unsafeDb.$disconnect())
  .catch(async (error) => {
    console.error(error)
    await unsafeDb.$disconnect()
    process.exit(1)
  })
