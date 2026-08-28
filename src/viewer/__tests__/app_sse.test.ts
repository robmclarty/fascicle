import { describe, expect, it } from 'vitest'
import {
  connect_events,
  parse_frame,
  type EventSourceLike,
  type SseStatus,
  type ViewerFrame,
} from '../app/sse.js'

/**
 * The SSE client is browser glue, but none of its decisions are: the frame
 * decoder and the status transitions are plain functions over strings and
 * callbacks. `connect_events` takes its `EventSource` as an argument for
 * exactly this reason, so the whole module runs here with no DOM.
 *
 * Equivalent-mutant ledger:
 *   - `catch { return null }` -> `catch {}` around `JSON.parse`: an empty
 *     catch leaves `parsed` as `undefined`, which the very next line rejects
 *     with the same `null`. The two paths differ only in how far they walk.
 */

type FakeSource = EventSourceLike & {
  readonly fire: (type: string, data?: string) => void
  readonly closed: () => boolean
}

/** A stand-in `EventSource` whose listeners the test fires by hand. */
function make_source(): FakeSource {
  const listeners = new Map<string, Array<(event: { data: string }) => void>>()
  let closed = false
  return {
    addEventListener: (type, listener) => {
      const bucket = listeners.get(type) ?? []
      bucket.push(listener)
      listeners.set(type, bucket)
    },
    close: () => {
      closed = true
    },
    fire: (type, data = '') => {
      for (const listener of listeners.get(type) ?? []) listener({ data })
    },
    closed: () => closed,
  }
}

type Harness = {
  readonly source: FakeSource
  readonly frames: ViewerFrame[]
  readonly statuses: SseStatus[]
  readonly urls: string[]
  readonly connection: ReturnType<typeof connect_events>
}

/** Wires `connect_events` to a fake source and records everything it reports. */
function connect(url = '/api/events'): Harness {
  const source = make_source()
  const frames: ViewerFrame[] = []
  const statuses: SseStatus[] = []
  const urls: string[] = []
  const connection = connect_events({
    url,
    open: (opened) => {
      urls.push(opened)
      return source
    },
    on_frame: (frame) => frames.push(frame),
    on_status: (status) => statuses.push(status),
  })
  return { source, frames, statuses, urls, connection }
}

describe('parse_frame', () => {
  it('reads kind and run_id off a well-formed event', () => {
    expect(parse_frame('{"kind":"span_start","run_id":"42b20e54"}')).toEqual({
      kind: 'span_start',
      run_id: '42b20e54',
    })
  })

  it('omits run_id rather than inventing one', () => {
    expect(parse_frame('{"kind":"emit"}')).toEqual({ kind: 'emit' })
    expect(parse_frame('{"kind":"emit","run_id":7}')).toEqual({ kind: 'emit' })
  })

  it('accepts a kind this build has never heard of (C7)', () => {
    expect(parse_frame('{"kind":"quantum_entanglement"}')).toEqual({
      kind: 'quantum_entanglement',
    })
  })

  it('rejects anything that is not an object with a string kind', () => {
    expect(parse_frame('not json')).toBeNull()
    expect(parse_frame('null')).toBeNull()
    expect(parse_frame('[]')).toBeNull()
    expect(parse_frame('42')).toBeNull()
    expect(parse_frame('"kind"')).toBeNull()
    expect(parse_frame('{}')).toBeNull()
    expect(parse_frame('{"kind":9}')).toBeNull()
  })
})

describe('connect_events', () => {
  it('opens the url it was given and reports connecting first', () => {
    const h = connect('/api/events')
    expect(h.urls).toEqual(['/api/events'])
    expect(h.statuses).toEqual(['connecting'])
  })

  it('goes live on open and offline on error', () => {
    const h = connect()
    h.source.fire('open')
    expect(h.statuses).toEqual(['connecting', 'live'])
    h.source.fire('error')
    expect(h.statuses).toEqual(['connecting', 'live', 'offline'])
  })

  it('goes offline on the server close frame', () => {
    const h = connect()
    h.source.fire('open')
    h.source.fire('close', '{}')
    expect(h.statuses).toEqual(['connecting', 'live', 'offline'])
  })

  it('forwards trajectory frames in order', () => {
    const h = connect()
    h.source.fire('trajectory', '{"kind":"flow_structure","run_id":"42b20e54"}')
    h.source.fire('trajectory', '{"kind":"span_start","run_id":"42b20e54"}')
    expect(h.frames).toEqual([
      { kind: 'flow_structure', run_id: '42b20e54' },
      { kind: 'span_start', run_id: '42b20e54' },
    ])
  })

  it('drops an undecodable frame instead of forwarding it', () => {
    const h = connect()
    h.source.fire('trajectory', 'half a line')
    h.source.fire('trajectory', '{"kind":"emit"}')
    expect(h.frames).toEqual([{ kind: 'emit' }])
  })

  it('ignores events on channels it did not subscribe to', () => {
    const h = connect()
    h.source.fire('message', '{"kind":"emit"}')
    expect(h.frames).toEqual([])
  })

  it('closes the underlying source', () => {
    const h = connect()
    expect(h.source.closed()).toBe(false)
    h.connection.close()
    expect(h.source.closed()).toBe(true)
  })
})
