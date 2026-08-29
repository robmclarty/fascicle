import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'

/**
 * The scar study, artboard 04 in a real browser: the fixture's fallback fires
 * when its primary throws terminally, so `always_throws` scars while
 * `safe_default` carries the run. The ring breaks, an ember ✕ orbits it, the
 * name drops to 55%, the primary through-line is left dead, and the scar
 * counts once in the header in ember, the only ember on the whole canvas.
 *
 * The full fixture is the injected terminal failure: folding it to the end
 * settles the run with the scar in place. The structural assertions pin what
 * the canvas says; the screenshot baseline pins how it says it.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

const fixture = readFileSync(
  join(HERE, '..', 'fixtures', 'fixture.trajectory.jsonl'),
  'utf8',
)

let viewer: ViewerHandle

test.beforeAll(async () => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0 })
  const res = await fetch(`${viewer.url}/api/ingest`, { method: 'POST', body: fixture })
  if (res.status !== 200) throw new Error(`fixture ingest failed: ${res.status}`)
})

// run_end freezes the header at the run's true duration, so no clock mock is
// needed for a stable T+; installing it only keeps the page deterministic.
test.beforeEach(async ({ page }) => {
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 60_000)
})

test.afterAll(async () => {
  await viewer.close()
})

test('the scar breaks the ring and orbits a single ember mark', async ({ page }) => {
  await page.goto(viewer.url)

  const scarred = page.locator('.node[data-node-id="always_throws"]')
  await expect(scarred).toHaveAttribute('data-scar', 'true')
  // The broken ring replaces the whole puck: no plain ring is drawn.
  await expect(scarred.locator('.puck')).toHaveCount(0)
  await expect(scarred.locator('.scar-ring')).toHaveCount(1)
  await expect(scarred.locator('.scar-mark')).toHaveCount(1)

  // Ember is only the mark: one on the scar, one on the retry's spent attempt,
  // and nowhere else on the canvas.
  await expect(page.locator('.scar-mark')).toHaveCount(1)
  await expect(page.locator('.fail-mark')).toHaveCount(1)

  // The name drops to 55% so the living path reads before the wound.
  const name_opacity = await scarred
    .locator('.node-name')
    .evaluate((element) => getComputedStyle(element).opacity)
  expect(name_opacity).toBe('0.55')
})

test('the light reroutes: dead primary, live-then-grey backup basin', async ({
  page,
}) => {
  await page.goto(viewer.url)

  // The dead segment past the scar stays unbuilt; the backup basin greyed.
  await expect(
    page.locator('[data-role="line"][data-to="always_throws"]'),
  ).toHaveAttribute('data-state', 'unbuilt')
  await expect(
    page.locator('[data-role="basin"][data-to="safe_default"]'),
  ).toHaveAttribute('data-state', 'traversed')
  // The approach into the fallback still greys: the light reached the scar.
  await expect(
    page.locator('[data-role="line"][data-to="fallback_1"]'),
  ).toHaveAttribute('data-state', 'traversed')
})

test('the scar counts once in the header, the numeral in ember', async ({ page }) => {
  await page.goto(viewer.url)

  const parts = await page.getByTestId('stats').locator('span').allTextContents()
  expect(parts.join(' ')).toBe('T+196MS · 1 RETRY ABSORBED · SCARS 1 · $0.0000')

  const scar = page.locator('.stats-scar')
  await expect(scar).toHaveText('1')
  const color = await scar.evaluate((element) => getComputedStyle(element).color)
  // #E2503E, the ember token, resolved to rgb by the browser.
  expect(color).toBe('rgb(226, 80, 62)')
})

test('the scar study matches the approved baseline', async ({ page }) => {
  await page.goto(viewer.url)
  await expect(page.getByTestId('node')).toHaveCount(9)
  await page.evaluate(() => document.fonts.ready)

  await expect(page).toHaveScreenshot('scar-study.png')
})
