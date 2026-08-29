import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'

/**
 * Play mode, in a real browser.
 *
 * The schedule math is pinned in app_playback.test.ts; what only a browser can
 * prove is the wiring: that pressing play makes the animation-frame clock walk
 * the held index through the whole run with no further input, that Space is
 * the toggle (Q5), and that the recording posture works end to end, the 2x
 * compressed loop performing while the idle fade clears every piece of
 * interaction chrome and a cursor twitch brings it back.
 *
 * The performance itself is the same fold the live and scrubber suites already
 * photograph (playback only moves the held index), so this spec asserts
 * through the DOM rather than adding screenshot baselines of a moving target.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'fixtures', 'fixture.trajectory.jsonl')

let viewer: ViewerHandle

test.beforeEach(async ({ page }) => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0, path: FIXTURE })
  await page.goto(viewer.url)
  await expect(page.getByTestId('run-id')).toHaveText('42b20e54')
  await expect(page.getByTestId('playback')).toBeVisible()
})

test.afterEach(async () => {
  await viewer.close()
})

test('Space performs the run from the live edge to its end, then stops', async ({ page }) => {
  const play = page.getByTestId('play-toggle')
  const first_stat = page.getByTestId('stats').locator('span').first()

  // At the live edge the playhead has nowhere forward, so play restarts at
  // T+0 and the chip flips to REPLAY. The 196ms fixture can finish before a
  // first poll lands, so the assertions pin the settled outcome: the clock
  // walked the schedule to the run's true end on its own and handed back.
  await page.keyboard.press('Space')
  await expect(page.getByTestId('status')).toHaveText('REPLAY')
  await expect(first_stat).toHaveText('T+196MS')
  await expect(play).toHaveText('PLAY')
  await expect(page.getByTestId('return-to-live')).toBeVisible()
})

test('Space is the play toggle: a looping performance pauses in place', async ({ page }) => {
  // The loop dial keeps the 196ms fixture performing forever, which is what
  // makes both halves of the toggle observable without a race.
  await page.getByTestId('loop-toggle').click()
  const play = page.getByTestId('play-toggle')
  await page.keyboard.press('Space')
  await expect(play).toHaveText('PAUSE')
  await page.keyboard.press('Space')
  await expect(play).toHaveText('PLAY')
  await expect(page.getByTestId('status')).toHaveText('REPLAY')
})

test('the speed dial cycles 1x -> 2x -> 3x -> 1x', async ({ page }) => {
  const speed = page.getByTestId('speed')
  await expect(speed).toHaveText('1X')
  await speed.click()
  await expect(speed).toHaveText('2X')
  await speed.click()
  await expect(speed).toHaveText('3X')
  await speed.click()
  await expect(speed).toHaveText('1X')
})

test('the 2x compressed loop records chrome-free until the cursor wakes it', async ({
  page,
}) => {
  // The recording posture: 2x, compression already on by default, loop so the
  // performance never hands back.
  await page.getByTestId('speed').click()
  await expect(page.getByTestId('speed')).toHaveText('2X')
  await expect(page.getByTestId('compress-toggle')).toHaveAttribute('data-active', 'true')
  await page.getByTestId('loop-toggle').click()
  await expect(page.getByTestId('loop-toggle')).toHaveAttribute('data-active', 'true')
  await page.getByTestId('play-toggle').click()
  await expect(page.getByTestId('play-toggle')).toHaveText('PAUSE')

  // Idle: every piece of interaction chrome fades to nothing while the loop
  // keeps performing.
  const canvas = page.locator('.canvas')
  await expect(canvas).toHaveAttribute('data-chrome', 'hidden', { timeout: 10_000 })
  await expect(page.getByTestId('scrubber')).toHaveCSS('opacity', '0')
  await expect(page.getByTestId('playback')).toHaveCSS('opacity', '0')
  await expect(page.getByTestId('status')).toHaveCSS('opacity', '0')
  await expect(page.getByTestId('play-toggle')).toHaveText('PAUSE')

  // A cursor twitch is the wake gesture.
  await page.mouse.move(400, 400)
  await expect(canvas).toHaveAttribute('data-chrome', 'visible')
})
