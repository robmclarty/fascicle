import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'

/**
 * The T+0 scaffold, artboard 06 in a real browser: the fixture's
 * `flow_structure` line alone must draw the whole composition as dim
 * scaffold, dashed lines under grey pucks, every caption present and nothing
 * invented. The structural assertions pin what the canvas says; the
 * screenshot baseline pins how it says it, and a change to either is a
 * design decision, not a refactor.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

const structure_line =
  readFileSync(join(HERE, '..', 'fixtures', 'fixture.trajectory.jsonl'), 'utf8').split(
    '\n',
  )[0] ?? ''

let viewer: ViewerHandle

test.beforeAll(async () => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0 })
  const res = await fetch(`${viewer.url}/api/ingest`, {
    method: 'POST',
    body: `${structure_line}\n`,
  })
  if (res.status !== 200) throw new Error(`fixture ingest failed: ${res.status}`)
})

test.afterAll(async () => {
  await viewer.close()
})

test('the header reads the artboard-06 T+0 line', async ({ page }) => {
  await page.goto(viewer.url)

  await expect(page.getByTestId('run-id')).toHaveText('42b20e54')
  await expect(page.getByTestId('status')).toHaveText('LIVE')
  const parts = await page.getByTestId('stats').locator('span').allTextContents()
  expect(parts.join(' ')).toBe('T+0MS · 0 RETRIES ABSORBED · SCARS 0 · $0.0000')
})

test('the scaffold draws every structural element, all unbuilt', async ({ page }) => {
  await page.goto(viewer.url)

  const nodes = page.getByTestId('node')
  await expect(nodes).toHaveCount(9)
  const rows = await nodes.evaluateAll((elements) =>
    elements.map((element) => [
      element.getAttribute('data-node-id'),
      element.querySelector('.node-name')?.textContent,
      element.querySelector('.node-meta')?.textContent,
      element.getAttribute('data-status'),
    ]),
  )
  expect(rows).toEqual([
    ['fetch_brief', 'fetch_brief', 'STEP', 'pending'],
    ['explode_sources', 'explode_sources', 'STEP', 'pending'],
    ['summarize', 'summarize', 'MAP', 'pending'],
    ['score', 'score', 'MAP', 'pending'],
    ['to_topic', 'to_topic', 'STEP', 'pending'],
    ['flaky_enrich', 'flaky_enrich', 'RETRY · 3 ATTEMPTS', 'pending'],
    ['always_throws', 'always_throws', 'STEP · PRIMARY', 'pending'],
    ['safe_default', 'safe_default', 'STEP · BACKUP', 'pending'],
    ['finalize', 'finalize', 'TERMINUS', 'pending'],
  ])

  // Every drawn line is scaffold: the run has traversed nothing yet.
  await expect(page.locator('.seg')).toHaveCount(18)
  await expect(page.locator('.seg-unbuilt')).toHaveCount(18)

  await expect(page.getByTestId('junction')).toHaveCount(1)
  await expect(page.getByTestId('junction').locator('.junction-label')).toHaveText('merge')

  await expect(page.locator('.group-text')).toHaveText([
    'PARALLEL_1',
    'RETRY_1',
    'FALLBACK_1 · ARMED',
  ])

  await expect(page.locator('.terminus-ring')).toHaveCount(1)
  await expect(
    page.locator('.node[data-node-id="finalize"] .terminus-ring'),
  ).toHaveCount(1)
})

test('metas show only what is known: no counts, no durations, no failures', async ({
  page,
}) => {
  await page.goto(viewer.url)
  await expect(page.getByTestId('node')).toHaveCount(9)

  const stage_text = (await page.getByTestId('stage').textContent()) ?? ''
  expect(stage_text).not.toContain('✕')
  expect(stage_text).not.toContain('×')
  expect(stage_text).not.toContain('MS')
  expect(stage_text).not.toContain('RUNNING')
})

test('the T+0 scaffold matches the approved baseline', async ({ page }) => {
  await page.goto(viewer.url)
  await expect(page.getByTestId('node')).toHaveCount(9)
  await page.evaluate(() => document.fonts.ready)

  await expect(page).toHaveScreenshot('t0-scaffold.png')
})
