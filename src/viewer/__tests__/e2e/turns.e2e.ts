import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'

/**
 * The turn inspector in a real browser, on a run whose model calls captured
 * their turns. The fixture is a real flow on `make_loop_engine` under
 * `capture: 'turns'`: `plan_trip` loops through three turns with two tools,
 * one of whose results went back flagged `is_error`, and then two calls run
 * side by side under a `parallel`, `packing_list` in one turn and
 * `book_hotel` in two. Each of the three nodes wears a turns badge; the
 * plain steps around them wear none.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'fixtures', 'turns.trajectory.jsonl')

let viewer: ViewerHandle

test.beforeEach(async ({ context }) => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0, path: FIXTURE })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
})

test.afterEach(async () => {
  await viewer.close()
})

test('each node whose call captured turns wears a badge with its count', async ({ page }) => {
  await page.goto(viewer.url)
  await expect(page.getByTestId('status')).toHaveText('DONE')

  const badge = (id: string) => page.locator(`.node[data-node-id="${id}"]`).getByTestId('turns-badge')
  await expect(badge('plan_trip')).toHaveText('3 TURNS')
  await expect(badge('packing_list')).toHaveText('1 TURN')
  await expect(badge('book_hotel')).toHaveText('2 TURNS')
  await expect(page.getByTestId('turns-badge')).toHaveCount(3)
  await expect(page.getByTestId('turn-drawer')).toHaveCount(0)
})

test('the badge opens the drawer on the newest turn, request beside response', async ({ page }) => {
  await page.goto(viewer.url)
  const badge = page.locator('.node[data-node-id="plan_trip"]').getByTestId('turns-badge')
  await badge.click()

  const drawer = page.getByTestId('turn-drawer')
  await expect(drawer).toBeVisible()
  await expect(badge).toHaveAttribute('data-open', 'true')
  await expect(drawer.locator('.td-node')).toHaveText('plan_trip')
  await expect(drawer.locator('.td-meta')).toHaveText('3 TURNS·anthropic · claude-sonnet-5-5')

  const rows = drawer.getByTestId('turn-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toHaveText('STEP 02,412 IN · 96 OUTCACHE 0%')
  await expect(rows.nth(1)).toHaveText('STEP 12,786 IN · 71 OUTCACHE 79%')
  await expect(rows.nth(2)).toHaveText('STEP 22,934 IN · 188 OUTCACHE 88%')
  await expect(rows.nth(2)).toHaveAttribute('data-selected', 'true')

  // The newest turn carries the whole conversation: the user's ask, the two
  // tool-calling turns, and every result fed back, the failed one flagged.
  const request = drawer.getByTestId('turn-request')
  await expect(request.getByTestId('turn-tools')).toHaveText('get_weather · convert_currency')
  const roles = await request.getByTestId('turn-message').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-role')),
  )
  expect(roles).toStrictEqual(['user', 'assistant', 'tool', 'tool', 'assistant', 'tool'])
  await expect(request.locator('.td-error')).toHaveCount(1)
  await expect(request.locator('.td-error')).toHaveText('✕')

  // The system prompt runs ten lines, so it folds to five until opened.
  const system = request.locator('.td-msg[data-role="system"]')
  await expect(system.getByTestId('fold-toggle')).toHaveText('+5 LINES')
  await system.getByTestId('fold-toggle').click()
  await expect(system.getByTestId('fold-toggle')).toHaveText('FOLD')
  await expect(system.locator('.td-text')).toContainText('No lists longer than five items.')

  // The reply runs nine lines, so it folds too, and opens to its last line.
  const response = drawer.getByTestId('turn-response')
  await expect(response).not.toContainText('Summary: Lisbon')
  await response.getByTestId('fold-toggle').click()
  await expect(response).toContainText('Summary: Lisbon, 7–8 Nov')
})

test('picking a turn shows its own request, and copy hands over the CapturedTurn', async ({ page }) => {
  await page.goto(viewer.url)
  await page.locator('.node[data-node-id="plan_trip"]').getByTestId('turns-badge').click()
  const drawer = page.getByTestId('turn-drawer')
  await drawer.getByTestId('turn-row').nth(0).click()
  await expect(drawer.getByTestId('turn-row').nth(0)).toHaveAttribute('data-selected', 'true')

  const roles = await drawer.getByTestId('turn-request').getByTestId('turn-message').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-role')),
  )
  expect(roles).toStrictEqual(['user'])
  await expect(drawer.getByTestId('turn-response').locator('.td-name-ref')).toHaveText([
    'get_weather',
    'get_weather',
  ])

  await drawer.getByTestId('copy-turn').click()
  await expect(drawer.getByTestId('copy-turn')).toHaveText('COPIED')
  const copied: unknown = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
  expect(copied).toMatchObject({
    step_index: 0,
    settings: { provider: 'anthropic', model_id: 'claude-sonnet-5-5', effort: 'none' },
    tools: [{ name: 'get_weather' }, { name: 'convert_currency' }],
    messages: [{ role: 'system' }, { role: 'user' }],
    response: [{ type: 'text' }, { type: 'tool_call' }, { type: 'tool_call' }],
  })
  expect(typeof copied === 'object' && copied !== null ? Object.keys(copied) : []).toStrictEqual([
    'call_span_id',
    'step_index',
    'settings',
    'tools',
    'messages',
    'response',
  ])

  // Another turn offers the copy again.
  await drawer.getByTestId('turn-row').nth(1).click()
  await expect(drawer.getByTestId('copy-turn')).toHaveText('COPY TURN')
})

test('the drawer follows the badge it was opened from, and closes', async ({ page }) => {
  await page.goto(viewer.url)
  await page.locator('.node[data-node-id="book_hotel"]').getByTestId('turns-badge').click()
  const drawer = page.getByTestId('turn-drawer')
  await expect(drawer.locator('.td-node')).toHaveText('book_hotel')
  await expect(drawer.getByTestId('turn-row')).toHaveCount(2)

  await page.locator('.node[data-node-id="packing_list"]').getByTestId('turns-badge').click()
  await expect(drawer.locator('.td-node')).toHaveText('packing_list')
  await expect(drawer.getByTestId('turn-request').locator('.td-msg[data-role="system"]')).toHaveCount(0)
  await expect(drawer.getByTestId('turn-request').getByTestId('turn-tools')).toHaveCount(0)

  await drawer.getByTestId('close-turns').click()
  await expect(page.getByTestId('turn-drawer')).toHaveCount(0)

  await page.locator('.node[data-node-id="packing_list"]').getByTestId('turns-badge').click()
  await expect(page.getByTestId('turn-drawer')).toBeVisible()
  await page.getByTestId('copy-turn').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('turn-drawer')).toHaveCount(0)
})

test('scrubbed back, the canvas inspects only the turns it has reached', async ({ page }) => {
  await page.goto(viewer.url)
  await expect(page.getByTestId('status')).toHaveText('DONE')
  // Home rewinds to T+0, before any turn was sent.
  await page.keyboard.press('Home')
  await expect(page.getByTestId('turns-badge')).toHaveCount(0)
  await page.keyboard.press('End')
  await expect(page.getByTestId('turns-badge')).toHaveCount(3)
})

test('the open drawer, in the canvas language', async ({ page }) => {
  await page.clock.install()
  await page.goto(viewer.url)
  await expect(page.getByTestId('status')).toHaveText('DONE')
  await page.locator('.node[data-node-id="plan_trip"]').getByTestId('turns-badge').click()
  await expect(page.getByTestId('turn-drawer')).toBeVisible()
  // The flow refits beside the drawer, so every badge stays in reach.
  const drawer = await page.getByTestId('turn-drawer').boundingBox()
  for (const badge of await page.getByTestId('turns-badge').all()) {
    const box = await badge.boundingBox()
    expect(box === null ? Infinity : box.x + box.width).toBeLessThan(drawer === null ? 0 : drawer.x)
  }
  await page.mouse.move(0, 0)
  await expect(page).toHaveScreenshot('turn-drawer.png')
})
