import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { create_broadcaster, type Broadcaster } from '../broadcast.js'
import {
  bound_port_of,
  internals_for_test,
  resolve_route,
  start_server,
  type ViewerServer,
} from '../server.js'

/**
 * Server tests in two registers. The routes, SSE fan-out, and ingest parsing
 * are exercised end to end against a real socket, because that is the contract
 * a browser sees. Three clusters cannot be reached that way and are unit-tested
 * against fake `req`/`res` objects through `internals_for_test`:
 *
 *   - The heartbeat is a 15s interval. Fake timers make it exact; a real
 *     socket would need a real 15-second wait.
 *   - The `event: close` frame is written from `req.on('close')`, by which
 *     point node has already torn the socket down (verified: a half-closed
 *     client never receives it). It is observable only at the handler seam.
 *   - `req.on('error')` during ingest answers 400 on a connection that has
 *     just failed, so the body never reaches a real client either.
 *
 * The compiled canvas is served from a real fixture directory built in a
 * temp dir rather than from `dist/viewer-app`, so the suite passes on a clean
 * checkout where nothing has been built, and the unbuilt-app 500 is reached by
 * pointing `app_dir` at a directory that does not exist. A `node:http`
 * passthrough mock hands back the created server so the bootstrap error
 * listener can be checked for leaks; it is transparent unless a test arms the
 * shared `gate`.
 *
 * Equivalent-mutant ledger (survivors left after this suite, classified here
 * rather than chased):
 *   - `req.url ?? '/'` -> `''`: the base is always `http://host:port` with no
 *     path, so `new URL('', base)` and `new URL('/', base)` both resolve to
 *     pathname `/`.
 *   - The `Host`-header branch in `resolve_route` (the `header !== undefined`
 *     condition, its try block, and the ``http://${header}`` base): a URL's
 *     pathname does not depend on the authority it is parsed against, so
 *     preferring the header, skipping it, or emptying it all resolve the same
 *     pathname, and a base the mutant breaks is caught and retried against the
 *     server's own authority. The branch exists to keep resolution total on a
 *     malformed header, which the malformed-host test pins; the route key it
 *     produces is header-independent by construction.
 *   - `trajectory_path !== undefined` -> `true` in `serve_trajectory`: entering
 *     the file branch with no path calls `stat_file(undefined)`, which returns
 *     null, so it falls through to the ring exactly as the guard would have.
 *   - `if (query === -1) return 0` -> `false` in `parse_since`: a url with no
 *     `?` slices from index 0, which is the whole url, and `URLSearchParams`
 *     finds no `since` in it, so the fallback returns 0 down the longer road.
 *   - `n > 0` -> `n >= 0` in `parse_last_event_id`: the two differ only at
 *     `n === 0`, which returns 0 down either branch.
 *   - `req.setEncoding('utf8')` -> `('')`: node's `normalizeEncoding` maps an
 *     empty encoding to utf8, so the stream decodes identically.
 *   - `if (buf.length > 0) consume_line(buf)` -> `true` / `>= 0`: an empty
 *     trailing buffer is dropped by `consume_line`'s own length guard.
 *   - `catch { return null }` -> `catch {}` in `stat_file`: an empty catch
 *     returns `undefined`, and every caller compares against `null` with a
 *     `=== null` that both values fail, or uses it in a boolean position.
 *     Separating them would mean asserting on a value no caller can see.
 *   - `file === null ? null : stat_file(file)` -> always `stat_file(file)`,
 *     and the matching `file === null ||` in the guard below it: `statSync`
 *     rejects a null path with a TypeError that `stat_file`'s own catch turns
 *     back into `null`, so the mutant reaches the same 404 by a longer road.
 *     The two null checks are what TypeScript needs to narrow `file` for
 *     `extname`, not a branch a request can take.
 */

const { parse_last_event_id, parse_since, handle_sse, handle_ingest, SSE_HEARTBEAT_MS } =
  internals_for_test

const gate = vi.hoisted(() => ({
  // The http.Server behind the most recent start_server call.
  last_http_server: null as Server | null,
}))

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args)
      gate.last_http_server = server
      return server
    },
  }
})

type FakeReq = EventEmitter & {
  readonly headers: IncomingHttpHeaders
  readonly setEncoding: (encoding: string) => void
}

const make_req = (headers: IncomingHttpHeaders = {}): FakeReq =>
  Object.assign(new EventEmitter(), { headers, setEncoding: () => {} })

const as_req = (req: FakeReq): IncomingMessage => req as unknown as IncomingMessage

type FakeRes = {
  statusCode: number
  readonly headers: Map<string, string>
  readonly writes_after_end: readonly string[]
  readonly writableEnded: boolean
  readonly setHeader: (name: string, value: string) => void
  readonly write: (chunk: string) => boolean
  readonly end: (body?: string) => void
  readonly text: () => string
}

const make_res = (): FakeRes => {
  const headers = new Map<string, string>()
  const writes: string[] = []
  const writes_after_end: string[] = []
  let ended = false
  return {
    statusCode: 0,
    headers,
    writes_after_end,
    get writableEnded() {
      return ended
    },
    setHeader: (name, value) => {
      headers.set(name, value)
    },
    write: (chunk) => {
      // Node answers a write-after-end with an async ERR_STREAM_WRITE_AFTER_END
      // rather than a throw. Recording it instead of throwing keeps a dropped
      // `writableEnded` guard visible as an assertion, not a crash.
      if (ended) writes_after_end.push(chunk)
      writes.push(chunk)
      return true
    },
    end: (body) => {
      if (body !== undefined) writes.push(body)
      ended = true
    },
    text: () => writes.join(''),
  }
}

const as_res = (res: FakeRes): ServerResponse => res as unknown as ServerResponse

let server: ViewerServer | null = null
let broadcaster: Broadcaster | null = null
let app_dir = ''

/**
 * Lays down a stand-in for the compiled canvas: an index page, a hashed asset
 * under `assets/`, a vendored font, and a nested file used to prove that a
 * traversal out of the directory is refused.
 */
function with_fixture_app(): void {
  beforeAll(() => {
    app_dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-app-'))
    mkdirSync(join(app_dir, 'assets'))
    mkdirSync(join(app_dir, 'fonts'))
    writeFileSync(join(app_dir, 'index.html'), '<title>fascicle viewer</title>')
    writeFileSync(join(app_dir, 'assets', 'index-abc.js'), 'console.log(1)')
    writeFileSync(join(app_dir, 'assets', 'index-abc.css'), '.canvas{}')
    writeFileSync(join(app_dir, 'fonts', 'sora-latin.woff2'), 'wOF2')
    writeFileSync(join(app_dir, 'fonts', 'sora-OFL.txt'), 'OFL')
    writeFileSync(join(app_dir, 'assets', 'sprite.svg'), '<svg/>')
    writeFileSync(join(app_dir, 'assets', 'shot.png'), 'PNG')
    writeFileSync(join(app_dir, 'manifest.json'), '{}')
    writeFileSync(join(app_dir, 'unmapped.bin'), 'bytes')
  })

  afterAll(() => {
    rmSync(app_dir, { recursive: true, force: true })
  })
}

/** Registers hooks giving every test in the calling describe a live server. */
function with_live_server(): void {
  beforeEach(async () => {
    broadcaster = create_broadcaster({ buffer: 100 })
    server = await start_server({ broadcaster, host: '127.0.0.1', port: 0, app_dir })
  })

  afterEach(async () => {
    if (server) await server.close()
    server = null
    broadcaster = null
  })
}

function url(path: string): string {
  if (!server) throw new Error('server not started')
  return server.url + path
}

describe('viewer http server', () => {
  with_fixture_app()
  with_live_server()

  it('GET /api/health returns ok with a json content-type', async () => {
    const res = await fetch(url('/api/health'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body: unknown = await res.json()
    expect(body).toEqual({ ok: true })
  })

  it('GET / serves the compiled app index with no-store cache headers', async () => {
    const res = await fetch(url('/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0)
    const text = await res.text()
    expect(text).toContain('<title>fascicle viewer</title>')
  })

  it('GET /index.html serves the same index', async () => {
    const res = await fetch(url('/index.html'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toContain('<title>fascicle viewer</title>')
  })

  it.each([
    ['/assets/index-abc.js', 'text/javascript; charset=utf-8', 'console.log(1)'],
    ['/assets/index-abc.css', 'text/css; charset=utf-8', '.canvas{}'],
    ['/fonts/sora-latin.woff2', 'font/woff2', 'wOF2'],
    ['/fonts/sora-OFL.txt', 'text/plain; charset=utf-8', 'OFL'],
    ['/assets/sprite.svg', 'image/svg+xml', '<svg/>'],
    ['/assets/shot.png', 'image/png', 'PNG'],
    ['/manifest.json', 'application/json; charset=utf-8', '{}'],
    ['/unmapped.bin', 'application/octet-stream', 'bytes'],
  ])('GET %s serves it as %s', async (path, content_type, body) => {
    const res = await fetch(url(path))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(content_type)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe(body)
  })

  it('404s an asset the compiled app does not ship', async () => {
    const res = await fetch(url('/assets/missing.js'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found', route: 'GET /assets/missing.js' })
  })

  it('refuses a path that climbs out of the app directory', async () => {
    // `fetch` normalizes `..` away, so the traversal is asserted at the seam
    // that would actually see it rather than through a client that cannot
    // send it.
    expect(internals_for_test.resolve_app_file(app_dir, '/../secret')).toBeNull()
    expect(internals_for_test.resolve_app_file(app_dir, '/assets/index-abc.js')).toBe(
      join(app_dir, 'assets', 'index-abc.js'),
    )
    expect(internals_for_test.resolve_app_file(app_dir, '/')).toBe(join(app_dir, 'index.html'))
  })

  it('rejects a POST to a path the api does not claim', async () => {
    const res = await fetch(url('/index.html'), { method: 'POST' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found', route: 'POST /index.html' })
  })

  it('GET /api/snapshot returns the ring buffer contents', async () => {
    if (!broadcaster) throw new Error('not initialized')
    broadcaster.emit({ kind: 'emit', text: 'one' })
    broadcaster.emit({ kind: 'emit', text: 'two' })
    const res = await fetch(url('/api/snapshot'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: { id: number; event: { kind: string } }[] }
    expect(body.events).toHaveLength(2)
    expect(body.events[0]?.event.kind).toBe('emit')
  })

  it('POST /api/ingest accepts NDJSON and broadcasts', async () => {
    if (!broadcaster) throw new Error('not initialized')
    const seen: Array<{ id: number }> = []
    const off = broadcaster.subscribe((e) => seen.push({ id: e.id }))
    const body = [
      JSON.stringify({ kind: 'span_start', span_id: 's1', name: 'step' }),
      JSON.stringify({ kind: 'span_end', span_id: 's1' }),
      '',
    ].join('\n')
    const res = await fetch(url('/api/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
    })
    off()
    expect(res.status).toBe(200)
    const out = (await res.json()) as { accepted: number; rejected: number }
    expect(out.accepted).toBe(2)
    expect(out.rejected).toBe(0)
    expect(seen).toHaveLength(2)
  })

  it('rejects both unparseable and schema-invalid lines without a parse-error callback', async () => {
    // No on_parse_error is wired here, so the schema-reject branch must guard
    // the optional callback rather than invoke it.
    const body = ['not json', '{"foo":"bar"}', JSON.stringify({ kind: 'emit' }), ''].join('\n')
    const res = await fetch(url('/api/ingest'), { method: 'POST', body })
    const out = (await res.json()) as { accepted: number; rejected: number }
    expect(out.accepted).toBe(1)
    expect(out.rejected).toBe(2)
  })

  it('GET /api/events streams trajectory events as SSE', async () => {
    if (!broadcaster) throw new Error('not initialized')
    broadcaster.emit({ kind: 'emit', text: 'one' })
    const ctrl = new AbortController()
    const res = await fetch(url('/api/events'), { signal: ctrl.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('connection')).toBe('keep-alive')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    if (!res.body) throw new Error('missing body')
    const reader = res.body.getReader()
    let buf = ''
    const deadline = Date.now() + 2000
    let saw_replay = false
    let saw_live = false
    broadcaster.emit({ kind: 'emit', text: 'two' })
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
      if (buf.includes('"text":"one"')) saw_replay = true
      if (buf.includes('"text":"two"')) saw_live = true
      if (saw_replay && saw_live) break
    }
    ctrl.abort()
    expect(saw_replay).toBe(true)
    expect(saw_live).toBe(true)
  })

  it('GET /api/events with Last-Event-ID skips already-seen events', async () => {
    if (!broadcaster) throw new Error('not initialized')
    broadcaster.emit({ kind: 'emit', text: 'one' })
    broadcaster.emit({ kind: 'emit', text: 'two' })
    const ctrl = new AbortController()
    const res = await fetch(url('/api/events'), {
      signal: ctrl.signal,
      headers: { 'last-event-id': '1' },
    })
    if (!res.body) throw new Error('missing body')
    const reader = res.body.getReader()
    let buf = ''
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
      if (buf.includes('"text":"two"')) break
    }
    ctrl.abort()
    expect(buf).not.toContain('"text":"one"')
    expect(buf).toContain('"text":"two"')
  })

  it('GET /api/events?since=N replays only past the query cursor', async () => {
    if (!broadcaster) throw new Error('not initialized')
    broadcaster.emit({ kind: 'emit', text: 'one' })
    broadcaster.emit({ kind: 'emit', text: 'two' })
    const ctrl = new AbortController()
    // A fresh load sets `?since` because native EventSource cannot send the
    // Last-Event-ID header on a first connect; the route still resolves by path.
    const res = await fetch(url('/api/events?since=1'), { signal: ctrl.signal })
    if (!res.body) throw new Error('missing body')
    const reader = res.body.getReader()
    let buf = ''
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
      if (buf.includes('"text":"two"')) break
    }
    ctrl.abort()
    expect(buf).not.toContain('"text":"one"')
    expect(buf).toContain('"text":"two"')
  })

  it('GET /api/trajectory serves the ring as NDJSON when there is no file', async () => {
    if (!broadcaster) throw new Error('not initialized')
    broadcaster.emit({ kind: 'emit', text: 'one' })
    broadcaster.emit({ kind: 'span_start', span_id: 's1', name: 'step' })
    const res = await fetch(url('/api/trajectory'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/x-ndjson/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // The cursor is the broadcaster head, the seam the client resumes SSE from.
    expect(res.headers.get('x-fascicle-cursor')).toBe('2')
    const lines = (await res.text()).split('\n').filter((line) => line.length > 0)
    expect(lines.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      'emit',
      'span_start',
    ])
  })

  it('GET /api/trajectory stamps a zero cursor and empty body on an empty ring', async () => {
    const res = await fetch(url('/api/trajectory'))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-fascicle-cursor')).toBe('0')
    expect(await res.text()).toBe('')
  })

  it('returns a json 404 naming the route for unknown routes', async () => {
    const res = await fetch(url('/nope'))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body: unknown = await res.json()
    expect(body).toEqual({ error: 'not_found', route: 'GET /nope' })
  })
})

describe('GET /api/trajectory from a file', () => {
  let dir = ''
  let srv: ViewerServer | null = null

  afterEach(async () => {
    if (srv) await srv.close()
    srv = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('streams the tailed file verbatim, stamping the broadcaster head', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-traj-'))
    const path = join(dir, 'run.jsonl')
    const body = [
      JSON.stringify({ kind: 'flow_structure', run_id: 'r1' }),
      JSON.stringify({ kind: 'span_start', span_id: 's1', name: 'step' }),
      '',
    ].join('\n')
    writeFileSync(path, body)

    const bc = create_broadcaster({ buffer: 100 })
    // The tail is what fills the broadcaster in production; here the head is
    // stamped from what the broadcaster holds, proving it is read off the ring
    // rather than counted from the file the client also folds.
    bc.emit({ kind: 'emit' })
    srv = await start_server({ broadcaster: bc, host: '127.0.0.1', port: 0, trajectory_path: path })

    const res = await fetch(`${srv.url}/api/trajectory`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/x-ndjson/)
    expect(res.headers.get('x-fascicle-cursor')).toBe('1')
    expect(await res.text()).toBe(body)
  })

  it('falls back to the ring when the configured file is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-traj-'))
    const bc = create_broadcaster({ buffer: 100 })
    bc.emit({ kind: 'emit', text: 'ring-only' })
    srv = await start_server({
      broadcaster: bc,
      host: '127.0.0.1',
      port: 0,
      // A path set but never created reads as "no file", so the route serves
      // the ring exactly as an ingest-only server would.
      trajectory_path: join(dir, 'never-written.jsonl'),
    })

    const res = await fetch(`${srv.url}/api/trajectory`)
    expect(res.status).toBe(200)
    const lines = (await res.text()).split('\n').filter((line) => line.length > 0)
    expect(lines.map((line) => (JSON.parse(line) as { text: string }).text)).toEqual(['ring-only'])
  })
})

describe('compiled app resolution', () => {
  it('answers a plain-text 500 when the canvas has not been built', async () => {
    const missing = join(tmpdir(), 'fascicle-viewer-app-never-built')
    const live = await start_server({
      broadcaster: create_broadcaster({ buffer: 10 }),
      host: '127.0.0.1',
      port: 0,
      app_dir: missing,
    })
    try {
      const res = await fetch(`${live.url}/`)
      expect(res.status).toBe(500)
      expect(res.headers.get('content-type')).toMatch(/text\/plain/)
      expect(await res.text()).toBe('viewer app not built; run `pnpm build`')
    } finally {
      await live.close()
    }
  })

  it('probes the published layout before the from-source one', () => {
    const candidates = internals_for_test.app_dir_candidates('/pkg/dist')
    expect(candidates).toEqual([resolve('/pkg/dist/viewer-app'), resolve('/pkg/dist/../../dist/viewer-app')])
  })

  it('resolves the from-source layout two levels above src/viewer', () => {
    const [, from_source] = internals_for_test.app_dir_candidates('/repo/src/viewer')
    expect(from_source).toBe(resolve('/repo/dist/viewer-app'))
  })

  it('takes an explicit app_dir over the bundled candidates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-override-'))
    try {
      writeFileSync(join(dir, 'index.html'), '<title>fascicle viewer</title>')
      expect(internals_for_test.resolve_app_dir(dir)).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a directory without an index.html as unbuilt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-empty-'))
    try {
      expect(internals_for_test.resolve_app_dir(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the bundled candidates when no app_dir is given', () => {
    // Whether dist/viewer-app exists depends on whether anything has been
    // built, so the assertion is on the shape of the answer, not the answer.
    const resolved = internals_for_test.resolve_app_dir(undefined)
    expect(resolved === null || resolved.endsWith('viewer-app')).toBe(true)
  })

  it('serves a directory whose index.html is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-built-'))
    try {
      writeFileSync(join(dir, 'index.html'), '<title>fascicle viewer</title>')
      expect(internals_for_test.resolve_app_dir(dir)).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats an index.html that is a directory as unbuilt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-dir-index-'))
    try {
      mkdirSync(join(dir, 'index.html'))
      expect(internals_for_test.resolve_app_dir(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolve_route', () => {
  it('builds "METHOD /pathname" from the request', () => {
    expect(
      resolve_route({ url: '/api/health', method: 'GET', headers: { host: 'h:1' } }, 'x', 9),
    ).toBe('GET /api/health')
    expect(resolve_route({ url: '/x?q=1', method: 'POST', headers: { host: 'h:1' } }, 'x', 9)).toBe(
      'POST /x',
    )
  })

  it('falls back to GET when the method is absent', () => {
    expect(resolve_route({ url: '/x', headers: { host: 'h:1' } }, 'x', 9)).toBe('GET /x')
  })

  it('falls back to the root path when the url is absent', () => {
    expect(resolve_route({ method: 'GET', headers: { host: 'h:1' } }, 'x', 9)).toBe('GET /')
  })

  it('falls back to host:port for the URL base when the Host header is absent', () => {
    // The base host only affects URL parsing; the route still resolves by path.
    expect(resolve_route({ url: '/x', method: 'GET', headers: {} }, 'myhost', 1234)).toBe('GET /x')
  })

  it('falls back to the server authority when the Host header is malformed', () => {
    // A present-but-malformed host is neither null nor undefined, so the old
    // `??` let it reach `new URL` and throw. Resolution must stay total.
    expect(resolve_route({ url: '/x', method: 'GET', headers: { host: 'in valid' } }, 'h', 9)).toBe(
      'GET /x',
    )
  })
})

describe('parse_since', () => {
  it('reads a positive integer from the since query', () => {
    expect(parse_since('/api/events?since=5')).toBe(5)
    expect(parse_since('/api/events?foo=1&since=42')).toBe(42)
    // A `?` at index 1 pins that the split is on the first `?`, not a fixed slot.
    expect(parse_since('/?since=9')).toBe(9)
  })

  it('returns 0 without a query, without since, or for an unusable value', () => {
    expect(parse_since('/api/events')).toBe(0)
    expect(parse_since('/api/events?foo=1')).toBe(0)
    expect(parse_since('/api/events?since=0')).toBe(0)
    expect(parse_since('/api/events?since=-3')).toBe(0)
    expect(parse_since('/api/events?since=abc')).toBe(0)
  })

  it('returns 0 for an absent url', () => {
    expect(parse_since(undefined)).toBe(0)
  })
})

describe('bound_port_of', () => {
  it('takes the port from a TCP AddressInfo', () => {
    expect(bound_port_of({ address: '127.0.0.1', family: 'IPv4', port: 4242 }, 0)).toBe(4242)
  })

  it('falls back when the server is not listening yet', () => {
    expect(bound_port_of(null, 8080)).toBe(8080)
  })

  it('falls back for a unix-socket path address', () => {
    expect(bound_port_of('/tmp/viewer.sock', 8080)).toBe(8080)
  })

  it('falls back for an address object carrying no port', () => {
    expect(bound_port_of({} as unknown as AddressInfo, 8080)).toBe(8080)
  })
})

describe('parse_last_event_id', () => {
  it('parses a positive integer string', () => {
    expect(parse_last_event_id('5')).toBe(5)
    expect(parse_last_event_id('42')).toBe(42)
  })

  it('returns 0 for zero, negatives, and non-numeric strings', () => {
    expect(parse_last_event_id('0')).toBe(0)
    expect(parse_last_event_id('-5')).toBe(0)
    expect(parse_last_event_id('abc')).toBe(0)
  })

  it('returns 0 for non-string header values', () => {
    expect(parse_last_event_id(undefined)).toBe(0)
    expect(parse_last_event_id(['5', '6'])).toBe(0)
  })
})

describe('viewer ingest details', () => {
  with_live_server()

  it('skips blank lines without counting them as rejected', async () => {
    const body = ['{"kind":"emit"}', '', '{"kind":"emit"}', ''].join('\n')
    const res = await fetch(url('/api/ingest'), { method: 'POST', body })
    const out = (await res.json()) as { accepted: number; rejected: number }
    expect(out.accepted).toBe(2)
    expect(out.rejected).toBe(0)
  })

  it('flushes a final line that has no trailing newline', async () => {
    const body = '{"kind":"emit"}\n{"kind":"emit"}'
    const res = await fetch(url('/api/ingest'), { method: 'POST', body })
    const out = (await res.json()) as { accepted: number; rejected: number }
    expect(out.accepted).toBe(2)
    expect(out.rejected).toBe(0)
  })

  it('invokes on_parse_error with the offending line for parse and schema failures', async () => {
    const bc = create_broadcaster({ buffer: 100 })
    const seen: Array<{ err: unknown; line: string }> = []
    const srv = await start_server({
      broadcaster: bc,
      host: '127.0.0.1',
      port: 0,
      on_parse_error: (err, line) => seen.push({ err, line }),
    })
    try {
      const body = ['not json', '{"foo":"bar"}', '{"kind":"emit"}', ''].join('\n')
      const res = await fetch(srv.url + '/api/ingest', { method: 'POST', body })
      const out = (await res.json()) as { accepted: number; rejected: number }
      expect(out.accepted).toBe(1)
      expect(out.rejected).toBe(2)
      expect(seen.map((s) => s.line)).toEqual(['not json', '{"foo":"bar"}'])
      // The first failure is a JSON parse error, the second a schema error.
      expect(seen[0]?.err).toBeInstanceOf(SyntaxError)
      expect(seen[1]?.err).not.toBeInstanceOf(SyntaxError)
    } finally {
      await srv.close()
    }
  })
})

describe('ingest stream failure', () => {
  it('answers a request stream error with a 400 and reports it', () => {
    const bc = create_broadcaster({ buffer: 10 })
    const seen: Array<{ err: unknown; line: string }> = []
    const req = make_req()
    const res = make_res()
    handle_ingest(as_req(req), as_res(res), bc, (err, line) => seen.push({ err, line }))

    const boom = new Error('ECONNRESET')
    req.emit('error', boom)

    expect(res.statusCode).toBe(400)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(res.text())).toEqual({ error: 'bad_request' })
    // The empty line marks "no line was in flight", distinguishing a transport
    // failure from a malformed record.
    expect(seen).toEqual([{ err: boom, line: '' }])
  })

  it('still answers 400 when no parse-error callback is wired', () => {
    const bc = create_broadcaster({ buffer: 10 })
    const req = make_req()
    const res = make_res()
    handle_ingest(as_req(req), as_res(res), bc)

    req.emit('error', new Error('ECONNRESET'))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.text())).toEqual({ error: 'bad_request' })
  })
})

describe('sse heartbeat and teardown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const open_stream = (): { req: FakeReq; res: FakeRes; bc: Broadcaster } => {
    const bc = create_broadcaster({ buffer: 10 })
    const req = make_req()
    const res = make_res()
    handle_sse(as_req(req), as_res(res), bc)
    return { req, res, bc }
  }

  it('flushes the response head with a comment frame as soon as it opens', () => {
    const { res } = open_stream()

    expect(res.text()).toBe(': connected\n\n')
    expect(res.headers.get('content-type')).toBe('text/event-stream')
  })

  it('writes a comment frame every heartbeat interval and not a tick sooner', () => {
    const { res } = open_stream()

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS - 1)
    expect(res.text()).toBe(': connected\n\n')

    vi.advanceTimersByTime(1)
    expect(res.text()).toBe(': connected\n\n: heartbeat\n\n')

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS)
    expect(res.text()).toBe(': connected\n\n: heartbeat\n\n: heartbeat\n\n')
  })

  it('closes the stream, stops heartbeats, and unsubscribes when the request closes', () => {
    const { req, res, bc } = open_stream()

    req.emit('close')

    expect(res.text()).toBe(': connected\n\nevent: close\ndata: {}\n\n')
    expect(res.writableEnded).toBe(true)

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 3)
    bc.emit({ kind: 'emit', text: 'after close' })
    expect(res.text()).toBe(': connected\n\nevent: close\ndata: {}\n\n')
  })

  it('tears the stream down the same way on a request stream error', () => {
    const { req, res } = open_stream()

    req.emit('error', new Error('ECONNRESET'))

    expect(res.text()).toBe(': connected\n\nevent: close\ndata: {}\n\n')
    expect(res.writableEnded).toBe(true)
  })

  it('writes the close frame once when a close follows an error', () => {
    const { req, res } = open_stream()

    req.emit('error', new Error('ECONNRESET'))
    req.emit('close')

    expect(res.text()).toBe(': connected\n\nevent: close\ndata: {}\n\n')
    expect(res.writes_after_end).toEqual([])
  })
})

describe('sse cursor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Opens an SSE stream against `bc`, with an optional request url carrying `?since`. */
  const open = (bc: Broadcaster, request_url?: string): { req: FakeReq; res: FakeRes } => {
    const req = Object.assign(make_req(), { url: request_url })
    const res = make_res()
    handle_sse(as_req(req), as_res(res), bc)
    return { req, res }
  }

  it('replays only past the ?since cursor a fresh load sets', () => {
    const bc = create_broadcaster({ buffer: 10 })
    bc.emit({ kind: 'emit', text: 'one' })
    bc.emit({ kind: 'emit', text: 'two' })
    bc.emit({ kind: 'emit', text: 'three' })

    const { req, res } = open(bc, '/api/events?since=2')

    expect(res.text()).not.toContain('"one"')
    expect(res.text()).not.toContain('"two"')
    expect(res.text()).toContain('"three"')
    req.emit('close')
  })

  it('drops live events at or below a cursor that ran ahead of the ring', () => {
    // The file the client folded held three events the broadcaster had not yet
    // caught up to, so the cursor sits ahead of the empty ring.
    const bc = create_broadcaster({ buffer: 10 })
    const { req, res } = open(bc, '/api/events?since=3')

    bc.emit({ kind: 'emit', text: 'one' })
    bc.emit({ kind: 'emit', text: 'two' })
    bc.emit({ kind: 'emit', text: 'three' })
    bc.emit({ kind: 'emit', text: 'four' })

    expect(res.text()).not.toContain('"one"')
    expect(res.text()).not.toContain('"three"')
    expect(res.text()).toContain('"four"')
    req.emit('close')
  })

  it('resumes from the furthest of the header and the since query', () => {
    const bc = create_broadcaster({ buffer: 10 })
    bc.emit({ kind: 'emit', text: 'one' })
    bc.emit({ kind: 'emit', text: 'two' })
    bc.emit({ kind: 'emit', text: 'three' })

    // The header names id 1, the query names id 2; the newer cursor wins, so id
    // 2 is skipped along with id 1.
    const req = Object.assign(make_req({ 'last-event-id': '1' }), { url: '/api/events?since=2' })
    const res = make_res()
    handle_sse(as_req(req), as_res(res), bc)

    expect(res.text()).not.toContain('"one"')
    expect(res.text()).not.toContain('"two"')
    expect(res.text()).toContain('"three"')
    req.emit('close')
  })
})

describe('viewer server lifecycle', () => {
  it('close() stops the server from accepting new connections', async () => {
    const bc = create_broadcaster({ buffer: 10 })
    const srv = await start_server({ broadcaster: bc, host: '127.0.0.1', port: 0 })
    const ok = await fetch(srv.url + '/api/health')
    expect(ok.status).toBe(200)
    await srv.close()
    await expect(fetch(srv.url + '/api/health')).rejects.toThrow()
  })

  it('close() rejects when the server is no longer running', async () => {
    const bc = create_broadcaster({ buffer: 10 })
    const srv = await start_server({ broadcaster: bc, host: '127.0.0.1', port: 0 })
    await srv.close()
    await expect(srv.close()).rejects.toThrow(/not running/i)
  })

  it('drops its bootstrap error listener once the socket is listening', async () => {
    const bc = create_broadcaster({ buffer: 10 })
    const srv = await start_server({ broadcaster: bc, host: '127.0.0.1', port: 0 })
    try {
      // Left attached, a late server error would settle an already-resolved
      // promise instead of surfacing.
      expect(gate.last_http_server?.listenerCount('error')).toBe(0)
    } finally {
      await srv.close()
    }
  })

  it('start_server rejects when the port is already in use', async () => {
    const bc = create_broadcaster({ buffer: 10 })
    const first = await start_server({ broadcaster: bc, host: '127.0.0.1', port: 0 })
    const port = Number(new URL(first.url).port)
    try {
      await expect(start_server({ broadcaster: bc, host: '127.0.0.1', port })).rejects.toThrow()
    } finally {
      await first.close()
    }
  })
})
