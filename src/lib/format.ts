/**
 * Display formatting shared by client components.
 *
 * `money` takes the decimal string the server sent and formats it for a person.
 * It is the **only** place a currency value becomes a JavaScript number, and it
 * happens at the last possible moment, for display alone — never for arithmetic
 * (`docs/02 §M1`). Nothing formatted here is ever read back.
 */
export function money(value: string | number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(value))
}
