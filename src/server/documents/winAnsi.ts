/**
 * Text going into a standard-font PDF.
 *
 * pdf-lib's built-in Helvetica is WinAnsi-encoded, and it *throws* when asked to
 * draw or even measure a character outside that set. That turns an em dash in a
 * note, a "−" in a report definition, or a store called "Ōtaki Dairy" into a
 * failed download — which is a far worse outcome than a slightly different
 * glyph. So every string is passed through here on its way to the page.
 *
 * Latin-1 accents (é, ñ, ü, ø) are inside WinAnsi and survive untouched. What is
 * mapped below is the punctuation that word processors and spreadsheets insert
 * without anyone noticing; anything still outside the set becomes "?" rather
 * than taking the document down with it.
 */

const SUBSTITUTIONS: [RegExp, string][] = [
  [/[‐-―−]/g, '-'], // hyphens, en/em dashes, the minus sign
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/…/g, '...'],
  [/ /g, ' '], // non-breaking space
  [/[ -​]/g, ' '], // the various typographic spaces
  [/×/g, 'x'],
  [/÷/g, '/'],
  [/≤/g, '<='],
  [/≥/g, '>='],
  [/≠/g, '!='],
  [/•/g, '-'],
  [/[✓✔]/g, 'Y'], // check marks
  [/[⚠️]/g, '!'],
  [/€/g, 'EUR'],
]

/**
 * WinAnsi is Latin-1 plus a handful of characters in 0x80–0x9F. Rather than
 * enumerate that block, allow Latin-1 and the few extras Helvetica actually
 * carries, and replace everything else.
 */
const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
])

export function toWinAnsi(value: string): string {
  let out = value
  for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement)

  let safe = ''
  for (const character of out) {
    const code = character.codePointAt(0) ?? 0
    // Control characters other than a plain space would draw as nothing useful.
    if (code < 0x20) {
      safe += code === 0x09 ? ' ' : ''
    } else if (code <= 0xff || WIN_ANSI_EXTRAS.has(code)) {
      safe += character
    } else {
      safe += '?'
    }
  }
  return safe
}
