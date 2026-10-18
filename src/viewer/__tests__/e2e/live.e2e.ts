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
    headers: { 'content-type': 'application/x-ndjson' },
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

/** Feed hand-written wire events to the live stream. */
async function ingest_events(events: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  const res = await fetch(`${viewer.url}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  })
  if (res.status !== 200) throw new Error(`event ingest failed: ${res.status}`)
}

/** The fixture's run id and the span ids of its first two steps. */
const RUN_ID = '42b20e54-41e6-47b2-8697-bda677867762'
const FETCH_BRIEF_SPAN = 'step:8cfe50e6'
const EXPLODE_SOURCES_SPAN = 'step:57e74a75'

test('an event keeps every glyph element and blooms an emit once', async ({ page }) => {
  await ingest(0, 3)
  const fetch_node = page.locator('.node[data-node-id="fetch_brief"]')
  await expect(fetch_node).toHaveAttribute('data-status', 'active')

  // Count every emit bloom the stage creates from here on, whether it arrives
  // alone or inside a rebuilt node, since each one restarts the animation.
  // The count rides a data attribute that the stage itself never sets.
  const stage = page.getByTestId('stage')
  await stage.evaluate((element) => {
    let count = 0
    element.setAttribute('data-blooms', '0')
    new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (!(added instanceof Element)) continue
          if (added.matches('.emit-bloom')) count += 1
          count += added.querySelectorAll('.emit-bloom').length
        }
      }
      element.setAttribute('data-blooms', String(count))
    }).observe(element, { childList: true, subtree: true })
  })

  await ingest_events([
    { kind: 'emit', label: 'progress', span_id: FETCH_BRIEF_SPAN, run_id: RUN_ID, ts: 1787368870100 },
  ])
  await expect(fetch_node.locator('.emit-bloom')).toHaveCount(1)
  await expect(stage).toHaveAttribute('data-blooms', '1')

  const pending_node = await page.locator('.node[data-node-id="finalize"]').elementHandle()
  const unbuilt_path = await page
    .locator('[data-role="line"][data-to="finalize"]')
    .elementHandle()
  const emitted_node = await fetch_node.elementHandle()

  // fetch_brief ends and explode_sources starts: nothing about finalize moves.
  await ingest(3, 5)
  await expect(fetch_node).toHaveAttribute('data-status', 'done')
  await expect(page.locator('.node[data-node-id="explode_sources"]')).toHaveAttribute(
    'data-status',
    'active',
  )

  // The handles are the elements from before the event, and the selectors
  // find the ones on the page now: the same element answers both.
  const same = await page.evaluate(
    ([node, path, emitted]) => [
      node === document.querySelector('.node[data-node-id="finalize"]'),
      path === document.querySelector('[data-role="line"][data-to="finalize"]'),
      emitted === document.querySelector('.node[data-node-id="fetch_brief"]'),
    ],
    [pending_node, unbuilt_path, emitted_node] as const,
  )
  expect(same).toStrictEqual([true, true, true])
  await expect(stage).toHaveAttribute('data-blooms', '1')

  await ingest_events([
    { kind: 'emit', label: 'progress', span_id: EXPLODE_SOURCES_SPAN, run_id: RUN_ID, ts: 1787368870130 },
  ])
  await expect(
    page.locator('.node[data-node-id="explode_sources"] .emit-bloom'),
  ).toHaveCount(1)
  await expect(stage).toHaveAttribute('data-blooms', '2')
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
