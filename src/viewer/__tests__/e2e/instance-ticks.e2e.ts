import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'
import { map_trajectory_ndjson } from '../fixtures/map-instances.js'

/**
 * Instance ticks at scale, artboard 03 in a real browser: a map's instances
 * render as perpendicular ticks on its outgoing line. At x3 they sit at the
 * canvas pitch; past a decade the ruler comb takes over with faint decade
 * numerals; a failure keeps its slot as an ember ✕; and only the still-open
 * window glows amber. Each scale is a synthetic run folded from
 * `map_trajectory`, so the pixels here and the geometry the scene unit tests
 * pin come off one source.
 *
 * Per D14 the comb uses the frozen two-tier token (pitch 18 beyond a decade),
 * so x12 renders at 18 rather than artboard 03's per-row 24; the baselines are
 * approved at 18. The lane the layout reserves is compact, so the at-scale
 * combs read as a dense ruler rather than the artboard's didactic spread.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

let viewer: ViewerHandle

test.beforeEach(async ({ page }) => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0 })
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 60_000)
})

test.afterEach(async () => {
  await viewer.close()
})

/** Ingest one scale's trajectory and wait for the canvas to draw it. */
async function show(page: import('@playwright/test').Page, ndjson: string): Promise<void> {
  const res = await fetch(`${viewer.url}/api/ingest`, { method: 'POST', body: ndjson })
  if (res.status !== 200) throw new Error(`ingest failed: ${res.status}`)
  await page.goto(viewer.url)
  await expect(page.locator('.node[data-node-id="summarize"]')).toHaveCount(1)
  await page.evaluate(() => document.fonts.ready)
}

const lane = '.tick-lane[data-owner="map_1"]'

test('x3 sits three grey ticks at the canvas pitch', async ({ page }) => {
  await show(page, map_trajectory_ndjson({ count: 3, run_id: 'ticks-x3' }))

  await expect(page.locator(`${lane} .tick-done`)).toHaveCount(3)
  await expect(page.locator(`${lane} .tick-fail`)).toHaveCount(0)
  await expect(page.locator(`${lane} .tick-live`)).toHaveCount(0)
  await expect(page.locator(`${lane} .tick-decade`)).toHaveCount(0)
  await expect(page.locator('.node[data-node-id="summarize"] .node-meta')).toHaveText(
    /^MAP ×3 · \d+MS$/,
  )

  await expect(page).toHaveScreenshot('ticks-x3.png')
})

test('x12 combs past the decade and keeps its one failure as an ember ✕', async ({
  page,
}) => {
  await show(page, map_trajectory_ndjson({ count: 12, failed: [4], run_id: 'ticks-x12' }))

  await expect(page.locator(`${lane} .tick-done`)).toHaveCount(11)
  await expect(page.locator(`${lane} .tick-fail`)).toHaveCount(1)
  await expect(page.locator(`${lane} .tick-live`)).toHaveCount(0)
  // The comb reads like a ruler: one decade numeral at 10.
  await expect(page.locator(`${lane} .tick-decade`)).toHaveText(['10'])

  const meta = page.locator('.node[data-node-id="summarize"] .node-meta')
  await expect(meta).toHaveText('MAP ×12 · 1 ✕')
  const fail = meta.locator('.meta-fail')
  await expect(fail).toHaveText('1 ✕')
  const color = await fail.evaluate((element) => getComputedStyle(element).fill)
  // #E2503E, the ember token, resolved to rgb by the browser.
  expect(color).toBe('rgb(226, 80, 62)')

  await expect(page).toHaveScreenshot('ticks-x12.png')
})

test('x50 draws the full ruler comb with only the running window lit amber', async ({
  page,
}) => {
  await show(page, map_trajectory_ndjson({ count: 50, live: 8, run_id: 'ticks-x50' }))

  await expect(page.locator(`${lane} .tick-done`)).toHaveCount(42)
  await expect(page.locator(`${lane} .tick-fail`)).toHaveCount(0)
  // Each alive tick is a crisp stroke over a blurred wash: eight of each.
  await expect(page.locator(`${lane} .tick-live`)).toHaveCount(8)
  await expect(page.locator(`${lane} .tick-live-glow`)).toHaveCount(8)
  // The comb reads like a ruler: a numeral at every decade.
  await expect(page.locator(`${lane} .tick-decade`)).toHaveText(['10', '20', '30', '40', '50'])

  await expect(page.locator('.node[data-node-id="summarize"] .node-meta')).toHaveText(
    'MAP ×50 · 8 LIVE',
  )

  await expect(page).toHaveScreenshot('ticks-x50.png')
})
