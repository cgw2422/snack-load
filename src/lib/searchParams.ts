/**
 * Next hands `searchParams` over as `string | string[] | undefined`: a query
 * param repeated in the URL arrives as an array. Every list screen here wants a
 * single value, so it is flattened once, at the edge, rather than each page
 * pretending arrays cannot happen.
 *
 * Last value wins, which is what a person editing a URL by hand expects.
 */
export type RawSearchParams = Record<string, string | string[] | undefined>

export function flattenSearchParams(raw: RawSearchParams): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value[value.length - 1]
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

export function firstValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[value.length - 1] : value
}
