import { createServer, request as forward, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { start_viewer, type ViewerHandle } from '../../index.js'

/**
 * The canvas served under a path of its own, the way a host that frames it
 * puts it behind a proxy at `/viewer/<id>/`.
 *
 * The proxy here does the two things a real one has to. It strips the prefix
 * before it forwards, and it sends the viewer's own loopback `Host`, which is
 * the only name the viewer's Host check answers. The rest is the app's job:
 * its assets, its history fetch, and its event stream all have to resolve
 * against the page. The run id proves history came through, the chip reading
 * DONE proves the stream connected, the fonts prove the CSS found them, and
 * no request may leave the prefix.
 *
 * Needs `pnpm build` (or `pnpm viewer:app`) to have compiled the canvas first.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'fixtures', 'fixture.trajectory.jsonl')
const PREFIX = '/viewer/abc'

let viewer: ViewerHandle
let proxy: Server
let page_url: string

/** A reverse proxy that serves `target` under PREFIX, as a host would. */
async function start_proxy(target: ViewerHandle): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (!url.startsWith(`${PREFIX}/`)) {
      res.writeHead(404).end()
      return
    }
    const upstream = forward(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: url.slice(PREFIX.length),
        headers: { ...req.headers, host: `${target.host}:${target.port}` },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

test.beforeEach(async () => {
  viewer = await start_viewer({ host: '127.0.0.1', port: 0, path: FIXTURE })
  proxy = await start_proxy(viewer)
  const address = proxy.address()
  if (address === null || typeof address === 'string') throw new Error('the proxy has no port')
  page_url = `http://127.0.0.1:${address.port}${PREFIX}/`
})

test.afterEach(async () => {
  proxy.closeAllConnections()
  await new Promise((resolve) => proxy.close(resolve))
  await viewer.close()
})

test('under a prefix, the canvas loads its assets, its history, its stream, and its fonts', async ({
  page,
}) => {
  const requested: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith('data:')) requested.push(request.url())
  })

  await page.goto(page_url)

  await expect(page.getByTestId('run-id')).toHaveText('42b20e54')
  await expect(page.getByTestId('status')).toHaveText('DONE')
  await page.evaluate(() => document.fonts.ready)
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
  )
  expect(loaded).toContain('Sora')
  expect(loaded).toContain('Spline Sans Mono')

  expect(requested.filter((url) => !url.startsWith(page_url))).toEqual([])
})
