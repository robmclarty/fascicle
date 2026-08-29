import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'

/**
 * The live run, artboard 01 in a real browser: spans move light through the
 * geometry, the retry circle carries its two lanes, and the header counts
 * between events.
 *
 * Every test freezes the page clock before load and feeds fixture lines by
 * hand, so each moment under test is an exact fold plus an exact amount of
 * silence. The artboard-01 reference state is the fold through the first
 * attempt's failure (T+113) plus 17ms of backoff pause: the header must read
 * `T+130MS` with amber only on the loop's live lane. The screenshot baseline
 * pins how it looks; a change to it is a design decision, not a refactor.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

const lines = readFileSync(join(HERE, '..', 'fixtures', 'fixture.trajectory.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)

/** The prefix whose fold is the artboard-01 moment: through attempt 1's failure. */
const MID_RUN = 29

let viewer: ViewerHandle

test.beforeEach(async ({ page }) => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0 })
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 60_000)
  await page.goto(viewer.url)
  await expect(page.getByTestId('status')).toHaveText('LIVE')
})

test.afterEach(async () => {
  await viewer.close()
})

/** Feed a half-open slice of fixture lines to the live stream. */
async function ingest(from: number, to: number): Promise<void> {
  const res = await fetch(`${viewer.url}/api/ingest`, {
    method: 'POST',
    body: `${lines.slice(from, to).join('\n')}\n`,
  })
  if (res.status !== 200) throw new Error(`fixture ingest failed: ${res.status}`)
}

test('a span moves light through its segment: pending, live, traversed', async ({
  page,
}) => {
  await ingest(0, 3)

  const entry = page.locator('.seg-live[data-role="entry"]')
  await expect(entry).toHaveCount(1)
  await expect(entry.locator('.seg-live-march')).toHaveCount(1)
  const march = await entry
    .locator('.seg-live-march')
    .evaluate((element) => getComputedStyle(element).animationName)
  expect(march).toBe('march')

  const fetch_node = page.locator('.node[data-node-id="fetch_brief"]')
  await expect(fetch_node).toHaveAttribute('data-status', 'active')
  await expect(fetch_node.locator('.node-meta')).toHaveText('STEP · RUNNING')
  await expect(page.locator('.halo')).toHaveCount(1)
  await expect(page.locator('.puck-core')).toHaveCount(1)

  await ingest(3, 4)
  await expect(page.locator('[data-role="entry"]')).toHaveAttribute(
    'data-state',
    'traversed',
  )
  await expect(fetch_node).toHaveAttribute('data-status', 'done')
  await expect(fetch_node.locator('.node-meta')).toHaveText('STEP · 42MS')
  await expect(page.locator('.halo')).toHaveCount(0)
})

test('the mid-run fold reads artboard 01: header, loop, and light', async ({ page }) => {
  await ingest(0, MID_RUN)
  await expect(page.locator('.fail-mark')).toHaveCount(1)

  // The fold's own clock, then 17ms of backoff silence: the artboard moment.
  await expect(page.getByTestId('stats').locator('span').first()).toHaveText('T+113MS')
  await page.clock.fastForward(17)
  const parts = await page.getByTestId('stats').locator('span').allTextContents()
  expect(parts.join(' ')).toBe('T+130MS · 1 RETRY ABSORBED · SCARS 0 · $0.0000')

  // The retry circle: spent lane grey with its ✕, live lane amber, exit unearned.
  await expect(page.locator('.seg-live[data-role="loop_upper"]')).toHaveCount(1)
  await expect(page.locator('[data-role="loop_lower"]')).toHaveAttribute(
    'data-state',
    'traversed',
  )
  await expect(page.locator('[data-role="line"][data-to="fallback_1"]')).toHaveAttribute(
    'data-state',
    'unbuilt',
  )

  // The light is parked on the attempt puck, mid-ledger.
  const flaky = page.locator('.node[data-node-id="flaky_enrich"]')
  await expect(flaky).toHaveAttribute('data-status', 'active')
  await expect(flaky.locator('.node-meta')).toHaveText('RETRY · ATT 2/3')
  await expect(page.locator('.halo')).toHaveCount(1)

  // Behind it the spine is traversed; ahead of it nothing is built.
  await expect(page.locator('[data-role="line"][data-to="retry_1"]')).toHaveAttribute(
    'data-state',
    'traversed',
  )
  await expect(page.locator('.seg-live')).toHaveCount(1)

  await page.evaluate(() => document.fonts.ready)
  await expect(page).toHaveScreenshot('mid-run.png')
})

test('the finished run settles: all grey, counts final, clock frozen', async ({
  page,
}) => {
  await ingest(0, lines.length)

  await expect(page.getByTestId('run-id')).toHaveText('42b20e54')
  await expect(page.locator('.node[data-node-id="finalize"]')).toHaveAttribute(
    'data-status',
    'done',
  )
  // `run_end` freezes the header at the run's true duration; no mock needed.
  const parts = await page.getByTestId('stats').locator('span').allTextContents()
  expect(parts.join(' ')).toBe('T+196MS · 1 RETRY ABSORBED · SCARS 1 · $0.0000')

  await expect(page.locator('.seg-live')).toHaveCount(0)
  // The scarred primary's through-line is the one dead segment left; every
  // other line has greyed.
  await expect(page.locator('[data-state="unbuilt"]')).toHaveCount(1)
  await expect(
    page.locator('[data-role="line"][data-to="always_throws"]'),
  ).toHaveAttribute('data-state', 'unbuilt')
  await expect(page.locator('.seg-traversed')).toHaveCount(17)
  await expect(page.locator('.halo')).toHaveCount(0)
  await expect(page.locator('.fail-mark')).toHaveCount(1)
})

test.describe('reduced motion (C9)', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('the marquee, halo, and LIVE dot park as static glow', async ({ page }) => {
    await ingest(0, 3)

    const march = page.locator('.seg-live-march')
    await expect(march).toHaveCount(1)
    expect(
      await march.evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none')
    expect(
      await page
        .locator('.halo')
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none')
    expect(
      await page
        .locator('.status-dot')
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none')
  })
})
