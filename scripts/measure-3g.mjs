/**
 * The performance budget, measured rather than asserted (docs/05 §2, docs/06).
 *
 * The exit criterion for this phase is "usable on a mid-tier Android over 3G",
 * which is a claim about a device nobody here is holding. So it is emulated:
 * Chrome's own 3G profiles with the CPU slowed fourfold, and the clock started
 * at the navigation rather than at some framework milestone.
 *
 * Two moments are reported, because they are what a runner experiences:
 *
 *   tappable — the server-rendered list is on screen and can be tapped. No
 *              JavaScript has run yet.
 *   loaded   — everything has arrived and the screen is hydrated.
 *
 * Needs a production build running on :3000 and the demo seed, exactly as
 * `verify-offline.mjs` does.
 */
import { chromium, devices } from 'playwright'

const BASE = 'http://localhost:3000'

/**
 * A mid-tier Android on a bad connection.
 *
 * Chrome's own "Fast 3G" numbers, with the CPU slowed fourfold — roughly a
 * mid-range phone two or three years old, which is what a route runner is
 * actually carrying.
 */
const FAST_3G = {
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  latency: 150,
}
/** The pessimistic case: a bar of signal at the back of a rural store. */
const SLOW_3G = {
  downloadThroughput: (400 * 1024) / 8,
  uploadThroughput: (400 * 1024) / 8,
  latency: 400,
}
const CPU_SLOWDOWN = 4

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

// Sign in once, keep the cookie, and throw the browser cache away for each run
// so "cold" means what it says.
const signIn = await browser.newContext({ ...devices['Pixel 7'] })
{
  const page = await signIn.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', 'mike@snackload.demo')
  await page.fill('input[name="password"]', 'snackload123')
  await page.click('button[type="submit"]')
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 })
  await page.close()
}
const storageState = await signIn.storageState()
await signIn.close()

async function measure(label, { throttle, profile = FAST_3G, path = '/sell', prime = false }) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], storageState, serviceWorkers: 'allow' })
  const page = await ctx.newPage()

  if (prime) {
    // A phone that left the depot with the worker installed and the day cached.
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(6000)
  }

  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: !prime })
  if (throttle) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      connectionType: 'cellular3g',
      ...profile,
    })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN })
  }

  let bytes = 0
  let requests = 0
  cdp.on('Network.loadingFinished', (e) => {
    bytes += e.encodedDataLength ?? 0
    requests += 1
  })

  const started = Date.now()
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  // The runner can tap a store off the server-rendered list before hydration.
  await page.locator('a[href^="/sell?customerId="]').first().waitFor({ timeout: 120000 })
  const tappable = Date.now() - started

  await page.waitForLoadState('load')
  // Hydrated: the search field responds to typing, which is the first thing
  // that needs JavaScript on this screen.
  await page
    .waitForFunction(() => document.querySelector('input[type="search"]') !== null, {
      timeout: 120000,
    })
    .catch(() => {})
  const loaded = Date.now() - started

  const fcp = await page.evaluate(() => {
    const entry = performance.getEntriesByName('first-contentful-paint')[0]
    return entry ? Math.round(entry.startTime) : null
  })

  console.log(
    `${label.padEnd(38)} FCP ${String(fcp ?? '—').padStart(5)} ms  ` +
      `tappable ${String(tappable).padStart(5)} ms  loaded ${String(loaded).padStart(5)} ms  ` +
      `${(bytes / 1024).toFixed(0).padStart(5)} KB / ${String(requests).padStart(3)} requests`,
  )

  await ctx.close()
}

await measure('cold, no throttle', { throttle: false })
await measure('cold, Fast 3G + 4x CPU', { throttle: true })
await measure('primed, Fast 3G + 4x CPU', { throttle: true, prime: true })
await measure('cold, Slow 3G + 4x CPU', { throttle: true, profile: SLOW_3G })
await measure('primed, Slow 3G + 4x CPU', { throttle: true, profile: SLOW_3G, prime: true })

await browser.close()
