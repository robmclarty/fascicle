import { EventEmitter } from 'node:events'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
 * A `node:fs` passthrough mock fails a single `statSync` to reach the
 * missing-viewer.html 500, and a `node:http` passthrough mock hands back the
 * created server so the bootstrap error listener can be checked for leaks.
 * Both are transparent unless a test arms the shared `gate`.
 *
 * Equivalent-mutant ledger (survivors left after this suite, classified here
 * rather than chased):
 *   - `req.url ?? '/'` -> `''`: the base is always `http://host:port` with no
 *     path, so `new URL('', base)` and `new URL('/', base)` both resolve to
 *     pathname `/`.
 *   - `req.headers.host ?? ...` -> `&&`: only separable by a present-but-
 *     malformed Host header, where the real code throws inside `new URL` and
 *     the mutant falls back. Pinning that would freeze a wart, not a contract
 *     (parked: the docstring claims the fallback covers malformed headers,
 *     but `??` only guards null/undefined).
 *   - `server.closeAllConnections?.()` -> `.()`: the method has existed since
 *     node 18.2 and `engines.node` is `>=24`, so the optional call can never
 *     short-circuit.
 *   - `n > 0` -> `n >= 0` in `parse_last_event_id`: the two differ only at
 *     `n === 0`, which returns 0 down either branch.
 *   - `req.setEncoding('utf8')` -> `('')`: node's `normalizeEncoding` maps an
 *     empty encoding to utf8, so the stream decodes identically.
 *   - `if (buf.length > 0) consume_line(buf)` -> `true` / `>= 0`: an empty
 *     trailing buffer is dropped by `consume_line`'s own length guard.
 */

const { parse_last_event_id, handle_sse, handle_ingest, SSE_HEARTBEAT_MS } = internals_for_test

const gate = vi.hoisted(() => ({
  // Armed by the 500 test: the next stat of any path fails, standing in for a
  // viewer.html that never shipped.
  static_missing: false,
  // The http.Server behind the most recent start_server call.
  last_http_server: null as Server | null,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (gate.static_missing) throw new Error('ENOENT: mock missing viewer.html')
      return actual.statSync(...args)
    },
  }
})

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

/** Registers hooks giving every test in the calling describe a live server. */
function with_live_server(): void {
  beforeEach(async () => {
    broadcaster = create_broadcaster({ buffer: 100 })
    server = await start_server({ broadcaster, host: '127.0.0.1', port: 0 })
  })

  afterEach(async () => {
    gate.static_missing = false
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
  with_live_server()

  it('GET /api/health returns ok with a json content-type', async () => {
    const res = await fetch(url('/api/health'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body: unknown = await res.json()
    expect(body).toEqual({ ok: true })
  })

  it('GET / serves the static viewer html with no-store cache headers', async () => {
    const res = await fetch(url('/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0)
    const text = await res.text()
    expect(text).toContain('<title>fascicle viewer</title>')
  })

  it('GET /index.html serves the same static html', async () => {
    const res = await fetch(url('/index.html'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('answers a plain-text 500 when the bundled viewer.html is missing', async () => {
    gate.static_missing = true
    const res = await fetch(url('/'))
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await res.text()).toBe('viewer.html missing')
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

  it('returns a json 404 naming the route for unknown routes', async () => {
    const res = await fetch(url('/nope'))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body: unknown = await res.json()
    expect(body).toEqual({ error: 'not_found', route: 'GET /nope' })
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

  it('writes a comment frame every heartbeat interval and not a tick sooner', () => {
    const { res } = open_stream()

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS - 1)
    expect(res.text()).toBe('')

    vi.advanceTimersByTime(1)
    expect(res.text()).toBe(': heartbeat\n\n')

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS)
    expect(res.text()).toBe(': heartbeat\n\n: heartbeat\n\n')
  })

  it('closes the stream, stops heartbeats, and unsubscribes when the request closes', () => {
    const { req, res, bc } = open_stream()

    req.emit('close')

    expect(res.text()).toBe('event: close\ndata: {}\n\n')
    expect(res.writableEnded).toBe(true)

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 3)
    bc.emit({ kind: 'emit', text: 'after close' })
    expect(res.text()).toBe('event: close\ndata: {}\n\n')
  })

  it('tears the stream down the same way on a request stream error', () => {
    const { req, res } = open_stream()

    req.emit('error', new Error('ECONNRESET'))

    expect(res.text()).toBe('event: close\ndata: {}\n\n')
    expect(res.writableEnded).toBe(true)
  })

  it('writes the close frame once when a close follows an error', () => {
    const { req, res } = open_stream()

    req.emit('error', new Error('ECONNRESET'))
    req.emit('close')

    expect(res.text()).toBe('event: close\ndata: {}\n\n')
    expect(res.writes_after_end).toEqual([])
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
