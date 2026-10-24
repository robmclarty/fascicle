/**
 * The span bookkeeping every line and HTTP logger shares.
 *
 * The logger tests drive this through their sinks but never look at parent
 * inference, so the open-span stack is pinned here: a caller-supplied parent
 * wins, the fallback names the innermost open span, and closing a span drops
 * exactly that span, even out of order or when the id was never opened.
 */

import { describe, expect, it } from 'vitest'
import { trajectory_recorder } from '../trajectory_recorder.js'

/** A recorder whose emitted events land in the returned array. */
function capture(): { events: Array<Record<string, unknown>>; logger: ReturnType<typeof trajectory_recorder> } {
  const events: Array<Record<string, unknown>> = []
  const logger = trajectory_recorder((event) => {
    events.push(event)
  })
  return { events, logger }
}

describe('trajectory_recorder', () => {
  it('names a span by its step name plus an eight-hex suffix, and emits its start', () => {
    const { events, logger } = capture()
    const id = logger.start_span('step', { id: 'a' })
    expect(id).toMatch(/^step:[0-9a-f]{8}$/)
    expect(events).toStrictEqual([{ kind: 'span_start', span_id: id, name: 'step', id: 'a' }])
  })

  it('leaves a root span without a parent_span_id key', () => {
    const { events, logger } = capture()
    logger.start_span('root')
    expect(events[0]).not.toHaveProperty('parent_span_id')
  })

  it('falls back to the innermost open span as the parent', () => {
    const { events, logger } = capture()
    const outer = logger.start_span('outer')
    const inner = logger.start_span('inner')
    logger.start_span('leaf')
    expect(events[1]?.['parent_span_id']).toBe(outer)
    expect(events[2]?.['parent_span_id']).toBe(inner)
  })

  it('keeps a caller-supplied parent over the open-span stack', () => {
    const { events, logger } = capture()
    logger.start_span('open')
    logger.start_span('child', { parent_span_id: 'threaded:1234abcd' })
    expect(events[1]?.['parent_span_id']).toBe('threaded:1234abcd')
  })

  it('emits a span end carrying its meta', () => {
    const { events, logger } = capture()
    const id = logger.start_span('step')
    logger.end_span(id, { id: 'a', error: 'boom' })
    expect(events[1]).toStrictEqual({ kind: 'span_end', span_id: id, id: 'a', error: 'boom' })
  })

  it('stops offering a closed span as a parent', () => {
    const { events, logger } = capture()
    const first = logger.start_span('first')
    logger.end_span(first)
    logger.start_span('second')
    expect(events[2]).not.toHaveProperty('parent_span_id')
  })

  it('drops exactly the closed span when spans close out of order', () => {
    // Concurrent siblings under parallel can finish in any order; the span
    // that closed must leave the stack without taking its neighbour with it.
    const { events, logger } = capture()
    const a = logger.start_span('a')
    const b = logger.start_span('b')
    const c = logger.start_span('c')
    logger.end_span(a)
    const d = logger.start_span('d')
    expect(events[4]?.['parent_span_id']).toBe(c)
    logger.end_span(b)
    logger.start_span('e')
    expect(events[6]?.['parent_span_id']).toBe(d)
  })

  it('leaves the stack alone when asked to close a span it never opened', () => {
    const { events, logger } = capture()
    const open = logger.start_span('open')
    logger.end_span('stranger:00000000')
    logger.start_span('child')
    expect(events[2]?.['parent_span_id']).toBe(open)
  })

  it('emits a record as written, as a copy of the caller event', () => {
    const { events, logger } = capture()
    const event = { kind: 'emit', text: 'hello' }
    logger.record(event)
    expect(events).toStrictEqual([{ kind: 'emit', text: 'hello' }])
    expect(events[0]).not.toBe(event)
  })
})
