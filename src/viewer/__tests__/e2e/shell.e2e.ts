import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'

/**
 * The compiled canvas, served by the real server, loaded by a real browser.
 *
 * Two things can only be proved here. The build output has to actually mount
 * (a vite config that emits an unreachable entry still passes every unit
 * test), and C3 has to hold at runtime: the page is watched for requests that
 * leave the viewer's own origin, which is a stronger claim than grepping the
 * bytes for a hostname.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

let viewer: ViewerHandle

test.beforeAll(async () => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0 })
})

test.afterAll(async () => {
  await viewer.close()
})

test('the shell mounts and connects to the event stream', async ({ page }) => {
  await page.goto(viewer.url)

  await expect(page.getByTestId('run-id')).toHaveText('········')
  await expect(page.getByTestId('status')).toHaveText('LIVE')
  const parts = await page.getByTestId('stats').locator('span').allTextContents()
  expect(parts.join(' ')).toBe('T+0MS · 0 RETRIES ABSORBED · SCARS 0 · $0.0000')
  await expect(page.getByTestId('stage')).toBeVisible()
})

test('the header adopts the run id and folds the clock off the wire', async ({ page }) => {
  await page.goto(viewer.url)
  await expect(page.getByTestId('status')).toHaveText('LIVE')

  const lines = [
    { kind: 'flow_structure', run_id: '42b20e54-41e6-47b2-8697-bda677867762', ts: 1000 },
    { kind: 'span_start', span_id: 'step:1', name: 'step', id: 'fetch_brief', ts: 1130 },
  ]
  const res = await fetch(`${viewer.url}/api/ingest`, {
    method: 'POST',
    body: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  })
  expect(res.status).toBe(200)

  await expect(page.getByTestId('run-id')).toHaveText('42b20e54')
  // T+130MS proves the second frame folded, not just the first.
  await expect(page.getByTestId('stats').locator('span').first()).toHaveText('T+130MS')
})

test('the page fetches nothing off its own origin (C3)', async ({ page }) => {
  const origin = new URL(viewer.url).origin
  const foreign: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) {
      foreign.push(request.url())
    }
  })

  await page.goto(viewer.url)
  await expect(page.getByTestId('status')).toHaveText('LIVE')
  // The fonts load lazily; wait for the CSS-declared families to settle so a
  // remote fallback fetch would have had its chance to fire.
  await page.evaluate(() => document.fonts.ready)

  expect(foreign).toEqual([])
})

test('the vendored families are the ones that render', async ({ page }) => {
  await page.goto(viewer.url)
  await page.evaluate(() => document.fonts.ready)

  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
  )
  expect(loaded).toContain('Sora')
  expect(loaded).toContain('Spline Sans Mono')
})
