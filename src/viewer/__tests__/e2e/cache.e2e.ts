import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'

/**
 * The header's cache stat, read off a finished run whose model turns cached.
 * The fixture's three turns write, then read, then miss: 5,000 of the run's
 * 16,900 input tokens came from the cache, so the header reads `CACHE 30%`,
 * and its one `cache_miss` reads `1 MISS`. The main fixture holds no
 * `response_received`, so its header, and every screenshot taken of it, has
 * no cache stat.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'fixtures', 'cache.trajectory.jsonl')

let viewer: ViewerHandle

test.beforeEach(async () => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0, path: FIXTURE })
})

test.afterEach(async () => {
  await viewer.close()
})

test('the header shows the run cache hit ratio and its misses', async ({ page }) => {
  await page.goto(viewer.url)

  await expect(page.getByTestId('run-id')).toHaveText('ca5ec0de')
  await expect(page.getByTestId('status')).toHaveText('DONE')

  const stats = page.getByTestId('stats').locator('span')
  const parts = await stats.allTextContents()
  expect(parts.join(' ')).toBe('T+201MS · 0 RETRIES ABSORBED · SCARS 0 · CACHE 30% · 1 MISS · $0.06')

  // The stat speaks the header's grammar: the word at the word opacity, the
  // numbers at the value opacity, and no ember, since a miss is no failure.
  await expect(stats.filter({ hasText: /^CACHE$/ })).toHaveClass('stats-word')
  await expect(stats.filter({ hasText: /^30%$/ })).toHaveClass('stats-value')
  await expect(stats.filter({ hasText: /^MISS$/ })).toHaveClass('stats-word')
  await expect(page.getByTestId('stats').locator('.stats-scar')).toHaveCount(0)
})
