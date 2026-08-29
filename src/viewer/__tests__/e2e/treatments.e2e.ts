import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'
import { TREATMENTS_EMIT_CUT, treatments_ndjson } from '../fixtures/state-treatments.js'

/**
 * The step-14 state treatments in a real browser: suspension, the emit
 * bloom, the checkpoint tick, and the annotation cards, all in the white
 * family with amber untouched (C4).
 *
 * The treatments fixture drives the states no artboard covers (the Q1
 * settle): a suspended run parks its node hollow with the double-bar and its
 * card, a checkpoint hit spares a node and wears the meta tick, and an emit
 * blooms the puck once. The main design fixture drives the Q4 card
 * lifecycle its retry and scar already exercise: the artboard-01 card while
 * attempt 2 is in flight, dismissed on resolve, and the scar's card
 * persisting at the end.
 *
 * The bloom is a one-shot 200ms animation, which `toHaveScreenshot` would
 * fast-forward to its invisible end state, so the baseline pins it through a
 * style override parking it at its peak instead.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

const lines = readFileSync(join(HERE, '..', 'fixtures', 'fixture.trajectory.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)

/** The design-fixture prefix whose fold is the artboard-01 moment. */
const MID_RUN = 29

let viewer: ViewerHandle

test.beforeEach(async ({ page }) => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0 })
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 60_000)
})

test.afterEach(async () => {
  await viewer.close()
})

/** Ingest a wire body and wait for the canvas to draw the named node. */
async function show(page: Page, body: string, node_id: string): Promise<void> {
  const res = await fetch(`${viewer.url}/api/ingest`, { method: 'POST', body })
  if (res.status !== 200) throw new Error(`ingest failed: ${res.status}`)
  await page.goto(viewer.url)
  await expect(page.locator(`.node[data-node-id="${node_id}"]`)).toHaveCount(1)
  await page.evaluate(() => document.fonts.ready)
}

/** A half-open slice of the design fixture as an ingest body. */
function fixture_slice(from: number, to: number): string {
  return `${lines.slice(from, to).join('\n')}\n`
}

test('suspension parks the node: hollow puck, double-bar, SUSPENDED, its card', async ({
  page,
}) => {
  await show(page, treatments_ndjson(), 'await_approval')

  const parked = page.locator('.node[data-node-id="await_approval"]')
  await expect(parked).toHaveAttribute('data-status', 'suspended')
  await expect(parked.locator('.pause-bar')).toHaveCount(2)
  await expect(parked.locator('.node-meta')).toHaveText('SUSPENDED')
  const fill = await parked
    .locator('.puck')
    .evaluate((element) => getComputedStyle(element).fill)
  expect(fill).toBe('none')

  // The light is parked, not moving: the approach greyed, the exit unearned,
  // and no amber anywhere on the canvas.
  await expect(
    page.locator('[data-role="line"][data-to="await_approval"]'),
  ).toHaveAttribute('data-state', 'traversed')
  await expect(page.locator('[data-role="line"][data-to="publish"]')).toHaveAttribute(
    'data-state',
    'unbuilt',
  )
  await expect(page.locator('.halo')).toHaveCount(0)
  await expect(page.locator('.seg-live')).toHaveCount(0)

  const card = page.locator('[data-testid="card"][data-owner="await_approval"]')
  await expect(card.locator('.card-title')).toHaveText('SUSPENDED')
  await expect(card.locator('.card-detail')).toHaveText('AWAITING RESUME')
  await expect(card.locator('.card-leader')).toHaveCount(1)
  await expect(card.locator('.card-dot')).toHaveCount(1)
})

test('a checkpoint hit spares its node and wears the white meta tick', async ({
  page,
}) => {
  await show(page, treatments_ndjson(), 'await_approval')

  const spared = page.locator('.node[data-node-id="expensive_brief"]')
  await expect(spared).toHaveAttribute('data-status', 'pending')
  await expect(spared.locator('.node-meta')).toHaveText('STEP ✓')
  await expect(spared.locator('.meta-check')).toHaveText('✓')
})

test('the suspended study matches the approved baseline', async ({ page }) => {
  await show(page, treatments_ndjson(), 'await_approval')
  await expect(page.getByTestId('node')).toHaveCount(5)

  await expect(page).toHaveScreenshot('suspended-study.png')
})

test('an emit blooms the running puck once, leaving no persistent mark', async ({
  page,
}) => {
  await show(page, treatments_ndjson(TREATMENTS_EMIT_CUT), 'gather')

  const running = page.locator('.node[data-node-id="gather"]')
  await expect(running).toHaveAttribute('data-status', 'active')
  await expect(running.locator('.emit-bloom')).toHaveCount(1)
  await expect(page.locator('.emit-bloom')).toHaveCount(1)

  // The screenshot pins the bloom at its peak: the one-shot animation is
  // parked by override because the harness would fast-forward it to its
  // invisible end frame.
  await page.addStyleTag({ content: '.emit-bloom { animation: none; opacity: 0.85; }' })
  await expect(page).toHaveScreenshot('emit-bloom.png')
})

test('the retry card rides attempt 2 and dismisses on resolve (Q4)', async ({
  page,
}) => {
  await show(page, fixture_slice(0, MID_RUN), 'flaky_enrich')

  const card = page.locator('[data-testid="card"][data-owner="flaky_enrich"]')
  await expect(card.locator('.card-title')).toHaveText('ATTEMPT 2 OF 3')
  await expect(card.locator('.card-detail')).toHaveText([
    'ATT 1 ✕ TRANSIENT UPSTREAM ERROR',
    'BACKOFF 25MS HONORED',
  ])
  const cross = card.locator('.card-fail')
  await expect(cross).toHaveText('✕')
  const color = await cross.evaluate((element) => getComputedStyle(element).fill)
  // #E2503E, the ember token, resolved to rgb by the browser.
  expect(color).toBe('rgb(226, 80, 62)')

  const res = await fetch(`${viewer.url}/api/ingest`, {
    method: 'POST',
    body: fixture_slice(MID_RUN, MID_RUN + 2),
  })
  if (res.status !== 200) throw new Error(`ingest failed: ${res.status}`)
  await expect(page.getByTestId('card')).toHaveCount(0)
})

test('the scar card persists once the run has settled', async ({ page }) => {
  await show(page, fixture_slice(0, lines.length), 'always_throws')

  const cards = page.getByTestId('card')
  await expect(cards).toHaveCount(1)
  const card = page.locator('[data-testid="card"][data-owner="always_throws"]')
  await expect(card.locator('.card-title')).toHaveText('PERMANENT FAILURE')
  await expect(card.locator('.card-detail')).toHaveText('✕ PRIMARY PATH UNAVAILABLE')
})
