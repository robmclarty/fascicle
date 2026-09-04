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
  // The gap floor spreads the fixture's 13 distinct moments into a
  // performance of about thirteen seconds, so this spec waits out a real
  // performance and needs a budget past Playwright's 30s default.
  test.setTimeout(60_000)
  const play = page.getByTestId('play-toggle')
  const first_stat = page.getByTestId('stats').locator('span').first()

  // At the live edge the playhead has nowhere forward, so play restarts at
  // T+0 and the chip flips to REPLAY. The floored length is long enough to
  // catch the clock running, so the spec pins both halves: the performance
  // is under way, then it walked the schedule to the run's true end on its
  // own and handed back. The finish waits past that length on purpose,
  // because the length is the thing being observed.
  await page.keyboard.press('Space')
  await expect(play).toHaveText('PAUSE')
  await expect(page.getByTestId('status')).toHaveText('REPLAY')
  await expect(first_stat).toHaveText('T+196MS', { timeout: 30_000 })
  await expect(play).toHaveText('PLAY')
  await expect(page.getByTestId('return-to-live')).toBeVisible()
})

test('a fast run performs as beats, not a flash: a second in, it is still running', async ({
  page,
}) => {
  // The fixture's whole run is 196ms of real time. Without the floor the
  // performance would be over before this spec could look; with it, one
  // second after Space the run has only just cleared its first beat.
  const play = page.getByTestId('play-toggle')
  await page.keyboard.press('Space')
  await expect(play).toHaveText('PAUSE')
  await page.waitForTimeout(1000)
  await expect(play).toHaveText('PAUSE')
  await expect(page.getByTestId('stats').locator('span').first()).not.toHaveText('T+196MS')
})

test('STEP hands the run to the hands: the chip and Space each advance a beat', async ({
  page,
}) => {
  const play = page.getByTestId('play-toggle')
  const first_stat = page.getByTestId('stats').locator('span').first()

  // Engaging opens the walk at T+0 and parks the clock, so the leading chip
  // stops offering to play and starts offering the next beat.
  await page.getByTestId('step-toggle').click()
  await expect(page.getByTestId('step-toggle')).toHaveAttribute('data-active', 'true')
  await expect(play).toHaveText('NEXT')
  await expect(page.getByTestId('status')).toHaveText('REPLAY')
  await expect(first_stat).toHaveText('T+0MS')

  // The fixture opens three events deep at the same millisecond, so the first
  // press folds that moment whole and the clock legitimately has not moved;
  // the second reaches the run's next moment at T+42MS.
  await page.keyboard.press('Space')
  await expect(first_stat).toHaveText('T+0MS')
  await page.keyboard.press('Space')
  await expect(first_stat).toHaveText('T+42MS')

  // The chip is the same advance as the key.
  await play.click()
  await expect(first_stat).toHaveText('T+43MS')

  // Nothing ever started running: a walk stops after every beat it takes.
  await expect(play).toHaveText('NEXT')
  await expect(page.locator('.canvas')).toHaveAttribute('data-chrome', 'visible')
})

test('leaving STEP hands the playhead back to the clock where the walk stopped', async ({
  page,
}) => {
  const play = page.getByTestId('play-toggle')
  await page.getByTestId('step-toggle').click()
  await page.keyboard.press('Space')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('stats').locator('span').first()).toHaveText('T+42MS')

  // The dial goes off without moving the playhead, and Space is the clock again.
  await page.getByTestId('step-toggle').click()
  await expect(page.getByTestId('step-toggle')).not.toHaveAttribute('data-active', 'true')
  await expect(play).toHaveText('PLAY')
  await expect(page.getByTestId('stats').locator('span').first()).toHaveText('T+42MS')
  await page.keyboard.press('Space')
  await expect(play).toHaveText('PAUSE')
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
