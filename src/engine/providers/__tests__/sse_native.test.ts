/**
 * The shared incremental SSE decoder: framing only, asserted directly on
 * push()/flush() payloads. Both native adapters' streaming suites exercise it
 * end to end on top of these.
 */

import { describe, expect, it } from 'vitest'
import { create_sse_decoder } from '../sse_native.js'

describe('create_sse_decoder', () => {
  it('emits a data payload when the blank line closes the event', () => {
    const sse = create_sse_decoder()
    expect(sse.push('event: message_stop\ndata: {"a":1}\n\n')).toEqual(['{"a":1}'])
  })

  it('joins multi-line data fields with newline per the SSE spec', () => {
    const sse = create_sse_decoder()
    expect(sse.push('data: line1\ndata: line2\n\n')).toEqual(['line1\nline2'])
  })

  it('strips carriage returns from CRLF line endings', () => {
    const sse = create_sse_decoder()
    expect(sse.push('data: x\r\n\r\n')).toEqual(['x'])
  })

  it('keeps a data value that has no space after the colon', () => {
    const sse = create_sse_decoder()
    expect(sse.push('data:x\n\n')).toEqual(['x'])
  })

  it('ignores comments and non-data fields', () => {
    const sse = create_sse_decoder()
    expect(sse.push(': keep-alive\nevent: ping\nid: 7\nretry: 100\ndata: y\n\n')).toEqual(['y'])
  })

  it('reassembles events split across pushes at arbitrary boundaries', () => {
    const sse = create_sse_decoder()
    expect(sse.push('da')).toEqual([])
    expect(sse.push('ta: hel')).toEqual([])
    expect(sse.push('lo\n')).toEqual([])
    expect(sse.push('\ndata: next\n\n')).toEqual(['hello', 'next'])
  })

  it('flushes an event left open when the stream ends without a blank line', () => {
    const sse = create_sse_decoder()
    expect(sse.push('data: tail')).toEqual([])
    expect(sse.flush()).toEqual(['tail'])
    expect(sse.flush()).toEqual([])
  })
})
