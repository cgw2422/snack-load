/**
 * What a spreadsheet column can map to (spec §8, §10).
 *
 * Incoming headers never have to match ours — "Item Description" maps to Product
 * Name, "Location" maps to Store Name. Each field carries the aliases we have
 * actually seen in distributor exports, which is what makes the suggested
 * mapping land on the right column most of the time.
 */

export type FieldKind = 'text' | 'money' | 'integer' | 'boolean' | 'email' | 'zip' | 'reference'

export type ImportField = {
  key: string
  label: string
  kind: FieldKind
  required?: boolean
  /** Can be used to match an existing record for update-in-place. */
  matchKey?: boolean
  help?: string
  aliases: string[]
}

export const PRODUCT_FIELDS: ImportField[] = [
  {
    key: 'sku', label: 'SKU', kind: 'text', required: true, matchKey: true,
    help: 'Your own item number. Used to match existing products.',
    aliases: ['sku', 'item', 'item #', 'item no', 'item number', 'item code', 'product code',
      'product #', 'product id', 'part number', 'part #', 'code', 'stock code', 'itemid'],
  },
  {
    key: 'upc', label: 'UPC / Barcode', kind: 'text', matchKey: true,
    aliases: ['upc', 'barcode', 'bar code', 'ean', 'gtin', 'scan code', 'upc code', 'upc-a'],
  },
  {
    key: 'name', label: 'Product Name', kind: 'text', required: true,
    aliases: ['name', 'product', 'product name', 'description', 'item description',
      'item name', 'product description', 'title', 'desc'],
  },
  {
    key: 'brand', label: 'Brand', kind: 'text',
    aliases: ['brand', 'manufacturer', 'mfg', 'make', 'vendor brand'],
  },
  {
    key: 'category', label: 'Category', kind: 'reference',
    help: 'Created if it does not exist yet.',
    aliases: ['category', 'dept', 'department', 'class', 'group', 'product category', 'type'],
  },
  {
    key: 'supplier', label: 'Supplier', kind: 'reference',
    help: 'Matched to an existing supplier, or created.',
    aliases: ['supplier', 'vendor', 'distributor', 'source', 'supplier name', 'vendor name'],
  },
  {
    key: 'caseCost', label: 'Case Cost', kind: 'money',
    help: 'What you pay for a full case. Divided by case quantity to get unit cost.',
    aliases: ['case cost', 'cost', 'unit cost', 'cost per case', 'buy price', 'wholesale',
      'wholesale cost', 'your cost', 'purchase price', 'landed cost'],
  },
  {
    key: 'casePrice', label: 'Case Price', kind: 'money',
    help: 'What the store pays for a full case.',
    aliases: ['case price', 'price', 'sell price', 'selling price', 'case', 'price per case',
      'retail', 'list price', 'wholesale price'],
  },
  {
    key: 'unitPrice', label: 'Unit Price', kind: 'money',
    aliases: ['unit price', 'each price', 'single price', 'piece price', 'ea price',
      'price each', 'individual price', 'srp'],
  },
  {
    key: 'caseQuantity', label: 'Case Quantity', kind: 'integer',
    help: 'How many individual items are in a case.',
    aliases: ['case quantity', 'case qty', 'pack', 'pack size', 'units per case', 'qty per case',
      'count', 'case pack', 'per case', 'uom qty', 'inner pack'],
  },
  {
    key: 'baseUomLabel', label: 'Unit Name', kind: 'text',
    help: 'What one of these is called — bag, bottle, bar.',
    aliases: ['unit', 'uom', 'unit name', 'unit of measure', 'each', 'sell by'],
  },
  {
    key: 'currentCases', label: 'Current Cases', kind: 'integer',
    help: 'Starting stock, in cases. Posted as a receipt into your main warehouse.',
    aliases: ['current cases', 'cases', 'cases on hand', 'qty on hand cases', 'stock cases',
      'on hand cases', 'beginning cases'],
  },
  {
    key: 'currentUnits', label: 'Current Units', kind: 'integer',
    help: 'Loose units on top of the whole cases.',
    aliases: ['current units', 'units', 'eaches', 'loose units', 'partial', 'on hand units',
      'qty on hand', 'quantity on hand', 'stock', 'on hand'],
  },
  {
    key: 'reorderCases', label: 'Reorder Level (cases)', kind: 'integer',
    aliases: ['reorder level', 'reorder', 'reorder point', 'min', 'minimum', 'par',
      'par level', 'safety stock', 'reorder cases'],
  },
  {
    key: 'taxable', label: 'Taxable', kind: 'boolean',
    aliases: ['taxable', 'tax', 'is taxable', 'taxed', 'sales tax'],
  },
  {
    key: 'active', label: 'Active', kind: 'boolean',
    aliases: ['active', 'status', 'enabled', 'discontinued', 'inactive'],
  },
]

export const CUSTOMER_FIELDS: ImportField[] = [
  {
    key: 'accountNumber', label: 'Account Number', kind: 'text', matchKey: true,
    help: 'Used to match existing stores. Generated if left blank.',
    aliases: ['account number', 'account', 'account #', 'acct', 'acct #', 'customer number',
      'customer id', 'store number', 'store #', 'cust no', 'id', 'number'],
  },
  {
    key: 'name', label: 'Store Name', kind: 'text', required: true, matchKey: true,
    aliases: ['store name', 'name', 'store', 'customer', 'customer name', 'location',
      'location name', 'account name', 'business name', 'dba', 'company'],
  },
  {
    key: 'parentCompany', label: 'Parent Company', kind: 'text',
    aliases: ['parent company', 'parent', 'chain', 'banner', 'group', 'corporate'],
  },
  {
    key: 'addressLine1', label: 'Address', kind: 'text',
    aliases: ['address', 'address 1', 'address line 1', 'street', 'street address', 'addr'],
  },
  {
    key: 'addressLine2', label: 'Address 2', kind: 'text',
    aliases: ['address 2', 'address line 2', 'suite', 'unit', 'apt'],
  },
  { key: 'city', label: 'City', kind: 'text', aliases: ['city', 'town', 'municipality'] },
  {
    key: 'state', label: 'State', kind: 'text',
    aliases: ['state', 'st', 'province', 'region'],
  },
  {
    key: 'postalCode', label: 'ZIP', kind: 'zip',
    aliases: ['zip', 'zip code', 'zipcode', 'postal', 'postal code', 'post code'],
  },
  {
    key: 'contactName', label: 'Contact', kind: 'text',
    aliases: ['contact', 'contact name', 'manager', 'owner', 'attention', 'attn', 'buyer'],
  },
  {
    key: 'phone', label: 'Phone', kind: 'text',
    aliases: ['phone', 'telephone', 'tel', 'phone number', 'contact phone', 'mobile', 'cell'],
  },
  {
    key: 'email', label: 'Email', kind: 'email',
    aliases: ['email', 'e-mail', 'email address', 'contact email'],
  },
  {
    key: 'route', label: 'Route', kind: 'reference',
    help: 'Matched to an existing route. You confirm anything ambiguous.',
    aliases: ['route', 'route name', 'rt', 'route #', 'territory', 'run'],
  },
  {
    key: 'runner', label: 'Assigned Runner', kind: 'reference',
    help: 'Matched to a person on your team. Never creates a user.',
    aliases: ['runner', 'driver', 'rep', 'salesperson', 'sales rep', 'assigned to',
      'route runner', 'employee', 'merchandiser'],
  },
  {
    key: 'visitDay', label: 'Visit Day', kind: 'text',
    aliases: ['visit day', 'day', 'service day', 'delivery day', 'weekday', 'call day'],
  },
  {
    key: 'frequency', label: 'Visit Frequency', kind: 'text',
    aliases: ['frequency', 'visit frequency', 'service frequency', 'cycle', 'how often'],
  },
  {
    key: 'preferredTime', label: 'Preferred Time', kind: 'text',
    aliases: ['preferred time', 'time', 'time window', 'delivery window', 'call time'],
  },
  {
    key: 'paymentTerms', label: 'Payment Terms', kind: 'text',
    aliases: ['terms', 'payment terms', 'pay terms', 'credit terms', 'net terms'],
  },
  {
    key: 'creditLimit', label: 'Credit Limit', kind: 'money',
    aliases: ['credit limit', 'limit', 'credit', 'max credit'],
  },
  {
    key: 'taxExempt', label: 'Tax Exempt', kind: 'boolean',
    aliases: ['tax exempt', 'exempt', 'tax free', 'non taxable', 'resale'],
  },
  {
    key: 'currentBalance', label: 'Current Balance', kind: 'money',
    help: 'Opening balance. Recorded as an opening invoice, not a silent edit.',
    aliases: ['current balance', 'balance', 'ar balance', 'open balance', 'amount due',
      'outstanding', 'owed'],
  },
  {
    key: 'notes', label: 'Notes', kind: 'text',
    aliases: ['notes', 'comment', 'comments', 'memo', 'remarks', 'special instructions'],
  },
  {
    key: 'active', label: 'Active', kind: 'boolean',
    aliases: ['active', 'status', 'enabled', 'inactive', 'closed'],
  },
]

export function fieldsFor(type: 'PRODUCTS' | 'CUSTOMERS'): ImportField[] {
  return type === 'PRODUCTS' ? PRODUCT_FIELDS : CUSTOMER_FIELDS
}

const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Suggests a mapping from the file's headers to our fields.
 *
 * Exact alias match first, then a containment match, then nothing — we would
 * rather leave a column unmapped than guess wrong and quietly put case costs in
 * the retail price column. Each header is claimed at most once.
 */
export function suggestMapping(
  headers: string[],
  fields: ImportField[],
): Record<string, string> {
  const mapping: Record<string, string> = {}
  const claimed = new Set<string>()

  const byAlias = new Map<string, ImportField>()
  for (const field of fields) {
    byAlias.set(normalize(field.label), field)
    for (const alias of field.aliases) byAlias.set(normalize(alias), field)
  }

  for (const header of headers) {
    const exact = byAlias.get(normalize(header))
    if (exact && !mapping[exact.key] && !claimed.has(header)) {
      mapping[exact.key] = header
      claimed.add(header)
    }
  }

  for (const header of headers) {
    if (claimed.has(header)) continue
    const normalized = normalize(header)
    if (!normalized) continue

    const match = fields.find(
      (field) =>
        !mapping[field.key] &&
        [field.label, ...field.aliases].some((alias) => {
          const a = normalize(alias)
          return a.length >= 4 && (normalized.includes(a) || a.includes(normalized))
        }),
    )
    if (match) {
      mapping[match.key] = header
      claimed.add(header)
    }
  }

  return mapping
}
