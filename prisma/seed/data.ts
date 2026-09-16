/**
 * Demo fixtures (spec §50).
 *
 * Deliberately shaped like a real independent distributor: a handful of brands
 * that actually move, cases priced below the unit multiple, partial cases on
 * hand, a couple of accounts carrying a balance, and one store that has clearly
 * gone quiet. Round, tidy numbers would hide the bugs this data is here to find.
 */

export type ProductSeed = {
  sku: string
  upc: string
  name: string
  brand: string
  category: 'Chips' | 'Candy' | 'Drinks' | 'Energy'
  supplier: string
  /** What one of these is called on its own — a bag, a bottle, a bar. */
  baseUomLabel: string
  unitsPerCase: number
  /** Landed cost of a full case. Per-base-unit cost is derived from it. */
  caseCost: number
  casePrice: number
  unitPrice: number
  /** Reorder point expressed in cases, converted to base units on insert. */
  reorderCases: number
  caseLabel?: 'CASE' | 'BOX' | 'PACK' | 'TRAY'
  taxable?: boolean
}

export const PRODUCTS: ProductSeed[] = [
  {
    sku: '1001', upc: '757528005207', name: 'Takis Fuego', brand: 'Barcel',
    category: 'Chips', supplier: 'Barcel USA', baseUomLabel: 'Bag',
    unitsPerCase: 12, caseCost: 14.4, casePrice: 19.5, unitPrice: 2.29, reorderCases: 60,
  },
  {
    sku: '1002', upc: '028400064057', name: 'Doritos Nacho Cheese', brand: 'Frito-Lay',
    category: 'Chips', supplier: 'PepsiCo', baseUomLabel: 'Bag',
    unitsPerCase: 12, caseCost: 15.0, casePrice: 20.4, unitPrice: 2.29, reorderCases: 34,
  },
  {
    sku: '1003', upc: '070847811169', name: 'Monster Energy 16oz', brand: 'Monster',
    category: 'Energy', supplier: 'Monster Beverage', baseUomLabel: 'Can',
    unitsPerCase: 24, caseCost: 26.4, casePrice: 33.5, unitPrice: 2.19, reorderCases: 30,
  },
  {
    sku: '1004', upc: '049000042559', name: 'Coca-Cola 20oz', brand: 'Coca-Cola',
    category: 'Drinks', supplier: 'Coca-Cola Consolidated', baseUomLabel: 'Bottle',
    unitsPerCase: 24, caseCost: 13.92, casePrice: 18.0, unitPrice: 1.19, reorderCases: 36,
  },
  {
    sku: '1005', upc: '012000001291', name: 'Mountain Dew 20oz', brand: 'Pepsi',
    category: 'Drinks', supplier: 'PepsiCo', baseUomLabel: 'Bottle',
    unitsPerCase: 24, caseCost: 13.68, casePrice: 17.75, unitPrice: 1.19, reorderCases: 34,
  },
  {
    sku: '1006', upc: '040000485285', name: 'Snickers Bar', brand: 'Mars',
    category: 'Candy', supplier: 'Mars Wrigley', baseUomLabel: 'Bar',
    unitsPerCase: 48, caseCost: 18.24, casePrice: 24.0, unitPrice: 0.89,
    reorderCases: 26, caseLabel: 'BOX',
  },
  {
    sku: '1007', upc: '034000002405', name: "Reese's Peanut Butter Cups", brand: 'Hershey',
    category: 'Candy', supplier: 'Hershey', baseUomLabel: 'Pack',
    unitsPerCase: 36, caseCost: 16.2, casePrice: 22.5, unitPrice: 0.99,
    reorderCases: 24, caseLabel: 'BOX',
  },
  {
    sku: '1008', upc: '052000338805', name: 'Gatorade Cool Blue 28oz', brand: 'Gatorade',
    category: 'Drinks', supplier: 'PepsiCo', baseUomLabel: 'Bottle',
    unitsPerCase: 15, caseCost: 14.25, casePrice: 19.5, unitPrice: 1.79, reorderCases: 26,
  },
  {
    sku: '1009', upc: '611269991000', name: 'Red Bull 12oz', brand: 'Red Bull',
    category: 'Energy', supplier: 'Red Bull North America', baseUomLabel: 'Can',
    unitsPerCase: 24, caseCost: 30.0, casePrice: 38.4, unitPrice: 2.49, reorderCases: 22,
  },
  {
    sku: '1010', upc: '028400199322', name: "Lay's Classic", brand: 'Frito-Lay',
    category: 'Chips', supplier: 'PepsiCo', baseUomLabel: 'Bag',
    unitsPerCase: 12, caseCost: 14.28, casePrice: 19.2, unitPrice: 2.19, reorderCases: 30,
  },
  {
    sku: '1011', upc: '012000191657', name: 'Starry 20oz', brand: 'Pepsi',
    category: 'Drinks', supplier: 'PepsiCo', baseUomLabel: 'Bottle',
    unitsPerCase: 24, caseCost: 13.68, casePrice: 17.75, unitPrice: 1.19, reorderCases: 24,
  },
  {
    sku: '1012', upc: '016000275263', name: 'Nature Valley Granola', brand: 'General Mills',
    category: 'Candy', supplier: 'Hershey', baseUomLabel: 'Pack',
    unitsPerCase: 30, caseCost: 15.6, casePrice: 21.0, unitPrice: 0.99,
    reorderCases: 18, caseLabel: 'TRAY',
  },
]

export const SUPPLIERS = [
  { name: 'PepsiCo', contactName: 'Regional Desk', phone: '(800) 433-2652', leadTimeDays: 3 },
  { name: 'Coca-Cola Consolidated', contactName: 'Order Desk', phone: '(800) 438-2653', leadTimeDays: 3 },
  { name: 'Mars Wrigley', contactName: 'Trade Sales', phone: '(800) 627-7852', leadTimeDays: 5 },
  { name: 'Hershey', contactName: 'Distributor Sales', phone: '(800) 468-1714', leadTimeDays: 5 },
  { name: 'Monster Beverage', contactName: 'Distribution', phone: '(800) 666-1337', leadTimeDays: 4 },
  { name: 'Red Bull North America', contactName: 'Wholesale', phone: '(800) 733-2285', leadTimeDays: 4 },
  { name: 'Barcel USA', contactName: 'Sales', phone: '(800) 227-2356', leadTimeDays: 7 },
]

export type CustomerSeed = {
  accountNumber: string
  name: string
  parentCompany?: string
  addressLine1: string
  city: string
  state: string
  postalCode: string
  latitude: number
  longitude: number
  phone: string
  contactName: string
  route: 'Route A' | 'Route B' | 'Route C'
  sequence: number
  terms: 'COD' | 'NET7' | 'NET15' | 'NET30'
  creditLimit?: number
  /** Rough weekly order size, used to generate believable history. */
  typicalOrder: number
  notes?: string
  /** Multiplier applied to recent orders, so "declining accounts" has something to find. */
  recentTrend?: number
}

export const CUSTOMERS: CustomerSeed[] = [
  {
    accountNumber: '1001', name: "Joe's Marathon", parentCompany: 'Marathon',
    addressLine1: '123 Main St.', city: 'Riverton', state: 'OH', postalCode: '44870',
    latitude: 41.4489, longitude: -82.7079, phone: '(555) 123-4567', contactName: 'Joe Bianchi',
    route: 'Route A', sequence: 1, terms: 'COD', typicalOrder: 286,
    notes: 'Back door before 9am. Ask for Joe.',
  },
  {
    accountNumber: '1002', name: 'Speedway #214', parentCompany: 'Speedway',
    addressLine1: '456 Oak Ave.', city: 'New Philadelphia', state: 'OH', postalCode: '44663',
    latitude: 40.4898, longitude: -81.4457, phone: '(555) 214-8800', contactName: 'Dana Kerr',
    route: 'Route A', sequence: 2, terms: 'NET15', creditLimit: 2500, typicalOrder: 412,
  },
  {
    accountNumber: '1003', name: 'BellStores', parentCompany: 'Bell',
    addressLine1: '789 Pine Rd.', city: 'Dover', state: 'OH', postalCode: '44622',
    latitude: 40.5209, longitude: -81.4746, phone: '(555) 300-1188', contactName: 'Amara Bell',
    route: 'Route A', sequence: 3, terms: 'NET30', creditLimit: 4000, typicalOrder: 524,
  },
  {
    accountNumber: '1004', name: 'Country Corner',
    addressLine1: '321 Maple St.', city: 'Sugarcreek', state: 'OH', postalCode: '44681',
    latitude: 40.5031, longitude: -81.6432, phone: '(555) 441-2020', contactName: 'Ruth Yoder',
    route: 'Route A', sequence: 4, terms: 'NET15', creditLimit: 1500, typicalOrder: 198,
    recentTrend: 0.56,
    notes: 'New manager since spring — orders have dropped off.',
  },
  {
    accountNumber: '1005', name: 'Marathon #512', parentCompany: 'Marathon',
    addressLine1: '652 Elm St.', city: 'Strasburg', state: 'OH', postalCode: '44680',
    latitude: 40.5978, longitude: -81.5293, phone: '(555) 512-7700', contactName: 'Nick Alvarez',
    route: 'Route A', sequence: 5, terms: 'COD', typicalOrder: 240,
  },
  {
    accountNumber: '1006', name: 'Lakeside Market',
    addressLine1: '88 Harbor Dr.', city: 'Huron', state: 'OH', postalCode: '44839',
    latitude: 41.3964, longitude: -82.5549, phone: '(555) 887-3311', contactName: 'Gina Park',
    route: 'Route B', sequence: 1, terms: 'NET15', creditLimit: 2000, typicalOrder: 355,
  },
  {
    accountNumber: '1007', name: 'Sunoco on 250', parentCompany: 'Sunoco',
    addressLine1: '1400 Milan Rd.', city: 'Sandusky', state: 'OH', postalCode: '44870',
    latitude: 41.4192, longitude: -82.6851, phone: '(555) 250-4400', contactName: 'Terry Dunn',
    route: 'Route B', sequence: 2, terms: 'COD', typicalOrder: 268,
  },
  {
    accountNumber: '1008', name: 'Circle K #9042', parentCompany: 'Circle K',
    addressLine1: '2200 Cleveland Rd.', city: 'Sandusky', state: 'OH', postalCode: '44870',
    latitude: 41.4351, longitude: -82.6503, phone: '(555) 904-2200', contactName: 'Priya Raman',
    route: 'Route B', sequence: 3, terms: 'NET30', creditLimit: 5000, typicalOrder: 610,
  },
  {
    accountNumber: '1009', name: 'Hilltop General Store',
    addressLine1: '7 Ridge Rd.', city: 'Berlin', state: 'OH', postalCode: '44610',
    latitude: 40.5620, longitude: -81.7943, phone: '(555) 610-9090', contactName: 'Marcus Webb',
    route: 'Route B', sequence: 4, terms: 'NET15', creditLimit: 1200, typicalOrder: 176,
  },
  {
    accountNumber: '1010', name: 'Valley View BP', parentCompany: 'BP',
    addressLine1: '990 State Route 39', city: 'Millersburg', state: 'OH', postalCode: '44654',
    latitude: 40.5545, longitude: -81.9179, phone: '(555) 654-1200', contactName: 'Sam Ortiz',
    route: 'Route C', sequence: 1, terms: 'COD', typicalOrder: 224,
  },
  {
    accountNumber: '1011', name: 'Riverside Grocery',
    addressLine1: '14 Water St.', city: 'Coshocton', state: 'OH', postalCode: '43812',
    latitude: 40.2720, longitude: -81.8593, phone: '(555) 812-3300', contactName: 'Helen Fry',
    route: 'Route C', sequence: 2, terms: 'NET30', creditLimit: 3000, typicalOrder: 448,
  },
  {
    accountNumber: '1012', name: 'Quick Stop #7',
    addressLine1: '505 S 2nd St.', city: 'Coshocton', state: 'OH', postalCode: '43812',
    latitude: 40.2661, longitude: -81.8619, phone: '(555) 812-7777', contactName: 'Doug Hale',
    route: 'Route C', sequence: 3, terms: 'NET7', creditLimit: 900, typicalOrder: 152,
  },
]

export const TEAM = [
  {
    email: 'owner@snackload.demo', firstName: 'Cody', lastName: 'Whitaker',
    role: 'owner' as const, phone: '(555) 200-0100',
  },
  {
    email: 'mike@snackload.demo', firstName: 'Mike', lastName: 'Donnelly',
    role: 'runner' as const, phone: '(555) 200-0101',
  },
  {
    email: 'sarah@snackload.demo', firstName: 'Sarah', lastName: 'Nguyen',
    role: 'runner' as const, phone: '(555) 200-0102',
  },
  {
    email: 'john@snackload.demo', firstName: 'John', lastName: 'Okafor',
    role: 'runner' as const, phone: '(555) 200-0103',
  },
  {
    email: 'dana@snackload.demo', firstName: 'Dana', lastName: 'Ruiz',
    role: 'warehouse' as const, phone: '(555) 200-0104',
  },
  {
    email: 'pat@snackload.demo', firstName: 'Pat', lastName: 'Sullivan',
    role: 'office' as const, phone: '(555) 200-0105',
  },
]

export const VEHICLES = [
  { truckNumber: '2', name: 'Truck #2', licensePlate: 'OH SNK-102', runnerEmail: 'mike@snackload.demo' },
  { truckNumber: '3', name: 'Truck #3', licensePlate: 'OH SNK-103', runnerEmail: 'sarah@snackload.demo' },
  { truckNumber: '4', name: 'Truck #4', licensePlate: 'OH SNK-104', runnerEmail: 'john@snackload.demo' },
]

export const ROUTES = [
  { name: 'Route A', code: 'A', color: '#1d4d8c', dayOfWeek: 'TUESDAY' as const, runnerEmail: 'mike@snackload.demo', truckNumber: '2' },
  { name: 'Route B', code: 'B', color: '#f04e23', dayOfWeek: 'WEDNESDAY' as const, runnerEmail: 'sarah@snackload.demo', truckNumber: '3' },
  { name: 'Route C', code: 'C', color: '#16a34a', dayOfWeek: 'THURSDAY' as const, runnerEmail: 'john@snackload.demo', truckNumber: '4' },
]

export const DEMO_PASSWORD = 'snackload123'
