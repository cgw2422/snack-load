/**
 * Units of measure (docs/02 §Q1–Q5).
 *
 * Every stored quantity in SnackLoad is a signed integer count of the product's
 * BASE unit. Cases, boxes, packs and trays are packaging: they convert to base
 * units once, at the edge, and the split back out is presentation only.
 *
 * This is what makes "18 cases + 7 bags" a first-class, representable state
 * instead of two columns that can drift into "-1 case, 11 bags".
 */

export type UomFactor = {
  /** How many base units one of these contains. Always ≥ 1. */
  baseUnitsPerUom: number
  label: string
}

export class UomError extends Error {}

export function assertValidFactor(factor: number): void {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new UomError(`A unit of measure must contain a whole number of base units, got ${factor}`)
  }
}

/** quantity (in this UoM) → base units. The conversion happens exactly once. */
export function toBaseUnits(quantity: number, baseUnitsPerUom: number): number {
  assertValidFactor(baseUnitsPerUom)
  if (!Number.isInteger(quantity)) {
    throw new UomError(`Quantity must be a whole number of units, got ${quantity}`)
  }
  return quantity * baseUnitsPerUom
}

/**
 * Split base units into whole packages plus a remainder, for display.
 * Never written back to storage.
 *
 *   splitQuantity(223, 12) → { packages: 18, remainder: 7 }
 */
export function splitQuantity(
  baseUnits: number,
  baseUnitsPerUom: number,
): { packages: number; remainder: number } {
  assertValidFactor(baseUnitsPerUom)
  const sign = baseUnits < 0 ? -1 : 1
  const abs = Math.abs(baseUnits)
  return {
    packages: sign * Math.floor(abs / baseUnitsPerUom),
    remainder: sign * (abs % baseUnitsPerUom),
  }
}

/**
 * Human quantity for a phone screen: "18 cs 7 ea", "15 cs", "7 ea", "0".
 * Short labels because this renders inside a 44px row next to a product name.
 */
export function formatQuantity(
  baseUnits: number,
  baseUnitsPerUom: number,
  labels: { package: string; unit: string } = { package: 'cs', unit: 'ea' },
): string {
  if (baseUnitsPerUom <= 1) return `${baseUnits} ${labels.unit}`
  const { packages, remainder } = splitQuantity(baseUnits, baseUnitsPerUom)
  if (packages === 0 && remainder === 0) return '0'
  const parts: string[] = []
  if (packages !== 0) parts.push(`${packages} ${labels.package}`)
  if (remainder !== 0) parts.push(`${remainder} ${labels.unit}`)
  return parts.join(' ')
}

/** Longer form for desktop tables: "18 cases, 7 bags". */
export function formatQuantityLong(
  baseUnits: number,
  baseUnitsPerUom: number,
  labels: { package: string; unit: string },
): string {
  if (baseUnitsPerUom <= 1) return `${baseUnits} ${pluralize(baseUnits, labels.unit)}`
  const { packages, remainder } = splitQuantity(baseUnits, baseUnitsPerUom)
  if (packages === 0 && remainder === 0) return `0 ${pluralize(0, labels.unit)}`
  const parts: string[] = []
  if (packages !== 0) parts.push(`${packages} ${pluralize(packages, labels.package)}`)
  if (remainder !== 0) parts.push(`${remainder} ${pluralize(remainder, labels.unit)}`)
  return parts.join(', ')
}

/**
 * "1 case", "3 cases", "2 boxes".
 *
 * Deliberately naive: the UoM labels a distributor uses — case, bag, tray, box,
 * pack — all take a plain -s or -es, and a real pluralisation library would be a
 * dependency earning nothing. Pure, so the sell and return screens can use it.
 */
export function pluralize(n: number, word: string): string {
  if (Math.abs(n) === 1) return word
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`
  return `${word}s`
}
