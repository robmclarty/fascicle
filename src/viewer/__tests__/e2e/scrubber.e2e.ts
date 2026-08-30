import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'
import { map_trajectory_ndjson } from '../fixtures/map-instances.js'

/**
 * The time scrubber and replay mode, in a real browser.
 *
 * Two claims can only be proved here. Scrubbing a loaded run walks the canvas
 * through the fold: opening the finished fixture with no live producer, the
 * keyboard alone drives the playhead from the T+0 scaffold, through the
 * artboard-01 mid-run moment, to the settled run, and the header T+ reduces
 * from the same prefix at every stop. And on a live run, scrubbing off the
 * newest event flips the chip from LIVE to REPLAY with a control that
 * re-attaches, which is a runtime interaction no unit test can reach.
 *
 * The stepping math and the T+ equality are pinned in app_timeline.test.ts; the
 * fixture offsets here (T+0, the failure at T+113, the run's T+196) are the same
 * numbers those tests assert, reached the other way, through the DOM.
 *
 * The DENSITY dial's suite rides here too: the bin math is pinned in
 * app_timeline.test.ts, and what only the browser can prove is the default-off
 * state, the localStorage round trip across a reload, and the shading pixels
 * themselves under the x50 map comb.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'fixtures', 'fixture.trajectory.jsonl')

const lines = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)

/** The event index whose fold is the artboard-01 moment: attempt 1's failure. */
const MID_RUN_STEPS = 28

let viewer: ViewerHandle

test.afterEach(async () => {
  await viewer.close()
})

test.describe('scrubbing a finished run from a file', () => {
  test.beforeEach(async ({ page }) => {
    viewer = await start_viewer({ host: '127.0.0.1', port: 0, path: FIXTURE })
    await page.goto(viewer.url)
    await expect(page.getByTestId('run-id')).toHaveText('42b20e54')
    await expect(page.getByTestId('scrubber')).toBeVisible()
  })

  test('the keyboard walks the canvas T+0 -> mid-run -> done', async ({ page }) => {
    const first_stat = page.getByTestId('stats').locator('span').first()

    // Home rewinds to the T+0 scaffold: everything unbuilt, the clock at zero.
    await page.keyboard.press('Home')
    await expect(first_stat).toHaveText('T+0MS')
    await expect(page.getByTestId('status')).toHaveText('REPLAY')
    await expect(page.getByTestId('return-to-live')).toBeVisible()
    await expect(page.locator('.node[data-node-id="flaky_enrich"]')).toHaveAttribute(
      'data-status',
      'pending',
    )

    // Stepping one event at a time reaches the retry's spent first attempt.
    for (let step = 0; step < MID_RUN_STEPS; step += 1) {
      await page.keyboard.press('ArrowRight')
    }
    await expect(first_stat).toHaveText('T+113MS')
    const flaky = page.locator('.node[data-node-id="flaky_enrich"]')
    await expect(flaky).toHaveAttribute('data-status', 'active')
    await expect(flaky.locator('.node-meta')).toHaveText('RETRY · ATT 2/3')

    // End re-attaches to the newest event: the settled run, the chip off REPLAY.
    await page.keyboard.press('End')
    const parts = await page.getByTestId('stats').locator('span').allTextContents()
    expect(parts.join(' ')).toBe('T+196MS · 1 RETRY ABSORBED · SCARS 1 · $0.0000')
    await expect(page.getByTestId('status')).not.toHaveText('REPLAY')
    await expect(page.getByTestId('return-to-live')).toHaveCount(0)
  })

  test('the mid-run scrub matches the approved baseline', async ({ page }) => {
    await page.keyboard.press('Home')
    for (let step = 0; step < MID_RUN_STEPS; step += 1) {
      await page.keyboard.press('ArrowRight')
    }
    await expect(page.getByTestId('stats').locator('span').first()).toHaveText('T+113MS')
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveScreenshot('scrub-mid-run.png')
  })
})

test.describe('the density dial', () => {
  test.beforeEach(async ({ page }) => {
    viewer = await start_viewer({ host: '127.0.0.1', port: 0 })
    await page.goto(viewer.url)
    const res = await fetch(`${viewer.url}/api/ingest`, {
      method: 'POST',
      body: map_trajectory_ndjson({ count: 50, failed: [7, 23], run_id: 'dense-x50' }),
    })
    if (res.status !== 200) throw new Error(`fixture ingest failed: ${res.status}`)
    await expect(page.getByTestId('scrubber')).toBeVisible()
  })

  test('defaults off, shades on toggle, and survives a reload', async ({ page }) => {
    const dial = page.getByTestId('density-toggle')
    await expect(page.locator('.scrub-density')).toHaveCount(0)
    await expect(dial).not.toHaveAttribute('data-active', 'true')

    await dial.click()
    await expect(dial).toHaveAttribute('data-active', 'true')
    await expect(page.locator('.scrub-density')).not.toHaveCount(0)

    // The preference persists: a reload reads it back out of localStorage.
    await page.reload()
    await expect(page.getByTestId('density-toggle')).toHaveAttribute('data-active', 'true')
    await expect(page.locator('.scrub-density')).not.toHaveCount(0)
  })

  test('the x50 comb shades a visible gradient under the failure marks', async ({
    page,
  }) => {
    const dial = page.getByTestId('density-toggle')
    await dial.click()
    await expect(page.locator('.scrub-density')).not.toHaveCount(0)
    // Blurred because the keypress below would otherwise upgrade the clicked
    // dial to :focus-visible and put the UA's blue ring in the baseline.
    await dial.blur()
    // Home parks the run in REPLAY, the same still chrome the mid-run baseline
    // freezes, with the band, both ember crosses, and the amber playhead in
    // one strip.
    await page.keyboard.press('Home')
    await expect(page.getByTestId('status')).toHaveText('REPLAY')
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveScreenshot('density-x50.png')
  })
})

test.describe('scrubbing off a live edge', () => {
  test.beforeEach(async ({ page }) => {
    viewer = await start_viewer({ host: '127.0.0.1', port: 0 })
    await page.goto(viewer.url)
    await expect(page.getByTestId('status')).toHaveText('LIVE')
    const res = await fetch(`${viewer.url}/api/ingest`, {
      method: 'POST',
      body: `${lines.join('\n')}\n`,
    })
    if (res.status !== 200) throw new Error(`fixture ingest failed: ${res.status}`)
    await expect(page.getByTestId('run-id')).toHaveText('42b20e54')
  })

  test('LIVE flips to REPLAY when held, and returns on the affordance', async ({ page }) => {
    await expect(page.getByTestId('status')).toHaveText('LIVE')
    await expect(page.getByTestId('return-to-live')).toHaveCount(0)

    await page.keyboard.press('Home')
    await expect(page.getByTestId('status')).toHaveText('REPLAY')
    await expect(page.getByTestId('stats').locator('span').first()).toHaveText('T+0MS')

    await page.getByTestId('return-to-live').click()
    await expect(page.getByTestId('status')).toHaveText('LIVE')
    await expect(page.getByTestId('return-to-live')).toHaveCount(0)
    await expect(page.getByTestId('stats').locator('span').first()).toHaveText('T+196MS')
  })
})
