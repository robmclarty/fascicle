import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'

/**
 * Opening a finished run from a file, D7's headline: the viewer tails a
 * completed `.trajectory.jsonl` with no live producer, and the canvas renders
 * the whole run from the first paint. This is the full-history path, not the
 * live one: nothing is ingested here, so the only way the run can appear is the
 * client folding `/api/trajectory` (the streamed file) before it follows SSE.
 *
 * The finished-run assertions mirror live.e2e's settled state, reached the
 * other way: there by feeding every line over ingest, here by loading the same
 * lines as history. Both must land on the same canvas.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'fixtures', 'fixture.trajectory.jsonl')

let viewer: ViewerHandle

test.beforeEach(async () => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0, path: FIXTURE })
})

test.afterEach(async () => {
  await viewer.close()
})

test('the finished fixture folds from the file with no live producer', async ({ page }) => {
  await page.goto(viewer.url)

  // The run id proves history folded at all; the rest proves it folded whole.
  await expect(page.getByTestId('run-id')).toHaveText('42b20e54')
  await expect(page.locator('.node[data-node-id="finalize"]')).toHaveAttribute(
    'data-status',
    'done',
  )

  // `run_end` is the last line, so the clock is frozen at the true duration
  // with no page-clock mock: the header reduces from the folded prefix alone.
  const parts = await page.getByTestId('stats').locator('span').allTextContents()
  expect(parts.join(' ')).toBe('T+196MS · 1 RETRY ABSORBED · SCARS 1 · $0.0000')

  // Nothing is alive; the one scarred through-line is the lone unbuilt segment.
  await expect(page.locator('.seg-live')).toHaveCount(0)
  await expect(page.locator('.halo')).toHaveCount(0)
  await expect(page.locator('[data-state="unbuilt"]')).toHaveCount(1)
  await expect(page.locator('.fail-mark')).toHaveCount(1)
})
