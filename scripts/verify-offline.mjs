/**
 * The offline contract, checked in a real browser (docs/05 §2, §3).
 *
 * `pnpm test` proves the queue and the services in isolation. This proves the
 * thing they exist for: a runner loses signal mid-route, takes a sale anyway,
 * and it reaches the office once — not twice, and not never.
 *
 * Needs a production build running on :3000 and the demo seed in the database:
 *
 *   pnpm db:seed
 *   QUICKBOOKS_USE_FAKE=false pnpm build && QUICKBOOKS_USE_FAKE=false pnpm start
 *   node scripts/verify-offline.mjs
 *
 * A development server will not do: the service worker is deliberately not
 * registered there, because a worker holding Turbopack output across an edit is
 * a debugging session nobody asked for.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'
/** Screenshots of each step, for a human to look at after a failure. */
const SHOTS = mkdtempSync(join(tmpdir(), 'snackload-verify-'))
const results = []
const check = (name, pass, detail = '') =>
  results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

async function signIn(page, email = 'mike@snackload.demo') {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', 'snackload123')
  await page.click('button[type="submit"]')
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 })
}

const readStore = (page, store) =>
  page.evaluate(
    (name) =>
      new Promise((resolve) => {
        const req = indexedDB.open('snackload')
        req.onsuccess = () => {
          const all = req.result.transaction(name, 'readonly').objectStore(name).getAll()
          all.onsuccess = () => resolve(all.result)
          all.onerror = () => resolve([])
        }
        req.onerror = () => resolve([])
      }),
    store,
  )

// ───────────────────────────────── a runner's day: online → dead zone → back
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'allow' })
  const page = await ctx.newPage()
  await signIn(page)

  // Polled rather than `waitForFunction`: that re-runs on every animation
  // frame, and opening an IndexedDB connection thousands of times starves the
  // page's own writes.
  let snaps = []
  for (let i = 0; i < 25; i += 1) {
    snaps = await readStore(page, 'snapshots')
    if (snaps.length >= 4) break
    await page.waitForTimeout(600)
  }
  const keys = snaps.map((s) => s.key).sort()
  check(
    'route, catalogue and balances cached, each with an asOf',
    ['balances', 'catalog', 'route-day'].every((k) => keys.includes(k)) &&
      snaps.filter((s) => s.key !== 'identity').every((s) => typeof s.asOf === 'string' && s.storedAt > 0),
    keys.join(', '),
  )

  const swScope = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration()
    return r?.active?.scriptURL ?? null
  })
  check('service worker is versioned by build id', Boolean(swScope?.includes('/sw.js?v=')), String(swScope))

  // Open a store's sell screen while there is still a signal.
  await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' })
  await page.locator('a[href^="/sell?customerId="]').first().click()
  await page.waitForURL('**/sell?customerId=*')
  const sellUrl = page.url()
  await page.waitForTimeout(500)

  // ── the dead zone ──────────────────────────────────────────────────────
  await ctx.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await page.waitForTimeout(500)

  check('offline banner appears', await page.getByText('No signal').first().isVisible().catch(() => false))

  // Add a product from the cached catalogue.
  const search = page.getByPlaceholder('Search or scan a product')
  await search.fill('Coca')
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${SHOTS}/10-sell-offline-search.png` })

  const hit = page.locator('button, li').filter({ hasText: /Coca/i }).first()
  const canPick = await hit.isVisible().catch(() => false)
  check('a product can be found offline from the cached catalogue', canPick)
  if (canPick) await hit.click().catch(() => {})
  await page.waitForTimeout(600)

  const estimated = await page.getByText('Estimated total').isVisible().catch(() => false)
  check('the total is labelled an estimate, not a price', estimated)
  const aged = await page.getByText(/Estimated from prices as of/).isVisible().catch(() => false)
  check('the estimate carries the age of the prices behind it', aged)
  await page.screenshot({ path: `${SHOTS}/11-sell-offline-cart.png`, fullPage: true })

  const saveButton = page.getByRole('button', { name: /Save on this phone/ })
  const canSave = await saveButton.isVisible().catch(() => false)
  check('the button says save, not checkout', canSave)

  if (canSave) {
    await saveButton.click()
    await page.waitForTimeout(1200)
  }

  const queued = await readStore(page, 'queue')
  check('the sale is written to the queue as intent only', queued.length === 1 &&
    !JSON.stringify(queued[0]?.payload ?? {}).match(/total|tax|price/i),
    JSON.stringify(queued.map((q) => ({ kind: q.kind, status: q.status, estimate: q.clientEstimate }))))

  const saidQueued = await page.getByText(/not posted yet/i).isVisible().catch(() => false)
  check('the screen says it is not posted yet', saidQueued)
  await page.screenshot({ path: `${SHOTS}/12-sell-queued.png`, fullPage: true })

  const trayVisible = await page.getByText(/waiting to send/i).first().isVisible().catch(() => false)
  check('the tray shows what is waiting', trayVisible)

  // ── the signal comes back ──────────────────────────────────────────────
  const posted = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/v1/sales')) posted.push(r.url())
  })

  await ctx.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.waitForTimeout(4000)

  // Reload twice: a replay must not post a second sale.
  await page.goto(sellUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await page.goto(sellUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)

  const after = await readStore(page, 'queue')
  check('the queue drains once the signal returns',
    after.every((q) => q.status === 'done') || after.length === 0,
    JSON.stringify(after.map((q) => ({ status: q.status, error: q.error }))))
  check('one POST per queued sale, however many times it is replayed',
    posted.length === 1, `${posted.length} posts`)

  await page.screenshot({ path: `${SHOTS}/13-after-reconnect.png`, fullPage: true })
  await ctx.close()
}

// ───────────────────────────────────── 320px: the narrowest phone still sold
{
  const ctx = await browser.newContext({
    viewport: { width: 320, height: 640 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'allow',
  })
  const page = await ctx.newPage()
  await signIn(page)

  for (const path of ['/', '/routes', '/sell', '/inventory', '/receivables', '/more', '/offline']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {})
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    check(`nothing scrolls sideways at 320px on ${path}`, over <= 0, `${over}px over`)
  }

  await ctx.close()
}

// ─────────────────────────── a navigation with no origin gets the static page
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'allow' })
  const page = await ctx.newPage()
  await signIn(page)
  await page
    .waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 20000 })
    .catch(() => {})
  await page.waitForTimeout(1500)

  await ctx.setOffline(true)
  await page.goto(`${BASE}/routes`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  check(
    'a navigation that cannot reach the origin gets the offline document',
    await page.getByRole('heading', { name: 'No connection' }).isVisible().catch(() => false),
  )
  await page.screenshot({ path: `${SHOTS}/20-offline-document.png`, fullPage: true })
  await ctx.setOffline(false)
  await ctx.close()
}

await browser.close()
console.log('\n' + results.join('\n'))
console.log(`\nScreenshots: ${SHOTS}`)
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
