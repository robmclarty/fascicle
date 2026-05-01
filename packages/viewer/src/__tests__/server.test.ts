import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { create_broadcaster, type Broadcaster } from '../broadcast.js'
import { start_server, type ViewerServer } from '../server.js'

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
  it('GET /api/health returns ok', async () => {
    const res = await fetch(url('/api/health'))
    expect(res.status).toBe(200)
    const body: unknown = await res.json()
    expect(body).toEqual({ ok: true })
  })

  it('GET / serves the static viewer html', async () => {
    const res = await fetch(url('/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const text = await res.text()
    expect(text).toContain('<title>fascicle viewer</title>')
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

  it('POST /api/ingest rejects malformed lines but accepts valid ones', async () => {
    const body = ['not json', JSON.stringify({ kind: 'emit' }), ''].join('\n')
    const res = await fetch(url('/api/ingest'), { method: 'POST', body })
    const out = (await res.json()) as { accepted: number; rejected: number }
    expect(out.accepted).toBe(1)
    expect(out.rejected).toBe(1)
  })

  it('GET /api/events streams trajectory events as SSE', async () => {
    if (!broadcaster) throw new Error('not initialized')
    broadcaster.emit({ kind: 'emit', text: 'one' })
    const ctrl = new AbortController()
    const res = await fetch(url('/api/events'), { signal: ctrl.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
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

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(url('/nope'))
    expect(res.status).toBe(404)
  })
})
