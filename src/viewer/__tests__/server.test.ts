import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { create_broadcaster, type Broadcaster } from '../broadcast.js'
import { internals_for_test, resolve_route, start_server, type ViewerServer } from '../server.js'

const { parse_last_event_id } = internals_for_test

let server: ViewerServer | null = null
let broadcaster: Broadcaster | null = null

beforeEach(async () => {
  broadcaster = create_broadcaster({ buffer: 100 })
  server = await start_server({ broadcaster, host: '127.0.0.1', port: 0 })
})

afterEach(async () => {
  if (server) await server.close()
  server = null
  broadcaster = null
})

function url(path: string): string {
  if (!server) throw new Error('server not started')
  return server.url + path
}

describe('viewer http server', () => {
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

  it('falls back to host:port for the URL base when the Host header is absent', () => {
    // The base host only affects URL parsing; the route still resolves by path.
    expect(resolve_route({ url: '/x', method: 'GET', headers: {} }, 'myhost', 1234)).toBe('GET /x')
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
  it('skips blank lines without counting them as rejected', async () => {
    if (!broadcaster) throw new Error('not initialized')
    const body = ['{"kind":"emit"}', '', '{"kind":"emit"}', ''].join('\n')
    const res = await fetch(url('/api/ingest'), { method: 'POST', body })
    const out = (await res.json()) as { accepted: number; rejected: number }
    expect(out.accepted).toBe(2)
    expect(out.rejected).toBe(0)
  })

  it('flushes a final line that has no trailing newline', async () => {
    if (!broadcaster) throw new Error('not initialized')
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

describe('viewer server lifecycle', () => {
  it('close() stops the server from accepting new connections', async () => {
    const bc = create_broadcaster({ buffer: 10 })
    const srv = await start_server({ broadcaster: bc, host: '127.0.0.1', port: 0 })
    const ok = await fetch(srv.url + '/api/health')
    expect(ok.status).toBe(200)
    await srv.close()
    await expect(fetch(srv.url + '/api/health')).rejects.toThrow()
  })

  it('start_server rejects when the port is already in use', async () => {
    const bc = create_broadcaster({ buffer: 10 })
    const first = await start_server({ broadcaster: bc, host: '127.0.0.1', port: 0 })
    const port = Number(new URL(first.url).port)
    try {
      await expect(
        start_server({ broadcaster: bc, host: '127.0.0.1', port }),
      ).rejects.toThrow()
    } finally {
      await first.close()
    }
  })
})
