export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** Appends -2, -3 … until `taken` says the slug is free. */
export async function uniqueSlug(
  base: string,
  taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const root = slugify(base) || 'company'
  if (!(await taken(root))) return root
  for (let n = 2; n < 500; n++) {
    const candidate = `${root}-${n}`
    if (!(await taken(candidate))) return candidate
  }
  return `${root}-${Date.now().toString(36)}`
}
