import { describe, expect, it, vi } from 'vitest'
import { stderr_logger } from '../stderr_logger.js'

function capture_stream(): { lines: () => Array<Record<string, unknown>>; write: (chunk: string) => unknown } {
  let raw = ''
  return {
    write: (chunk: string) => {
      raw += chunk
      return true
    },
    lines: () =>
      raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l): Record<string, unknown> => JSON.parse(l) as Record<string, unknown>),
  }
}

describe('stderr_logger', () => {
  it('writes each record as one JSON object per line', () => {
    const stream = capture_stream()
    const logger = stderr_logger({ stream })

    logger.record({ kind: 'emit', text: 'hello' })
    logger.record({ kind: 'emit', text: 'world' })

    expect(stream.lines()).toEqual([
      { kind: 'emit', text: 'hello' },
      { kind: 'emit', text: 'world' },
    ])
  })

  it('emits span_start and span_end for each start/end call', () => {
    const stream = capture_stream()
    const logger = stderr_logger({ stream })

    const id = logger.start_span('step', { id: 'a' })
    logger.end_span(id, { id: 'a' })

    const lines = stream.lines()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ kind: 'span_start', span_id: id, name: 'step', id: 'a' })
    expect(lines[1]).toMatchObject({ kind: 'span_end', span_id: id, id: 'a' })
  })

  it('nested sequential spans carry parent_span_id on the child', () => {
    const stream = capture_stream()
    const logger = stderr_logger({ stream })

    const outer = logger.start_span('sequence', { id: 'seq_1' })
    const inner = logger.start_span('step', { id: 'a' })
    logger.end_span(inner, { id: 'a' })
    logger.end_span(outer, { id: 'seq_1' })

    const lines = stream.lines()
    const outer_start = lines.find((l) => l['span_id'] === outer && l['kind'] === 'span_start')
    const inner_start = lines.find((l) => l['span_id'] === inner && l['kind'] === 'span_start')

    expect(outer_start?.['parent_span_id']).toBeUndefined()
    expect(inner_start?.['parent_span_id']).toBe(outer)
  })

  it('prefers a caller-supplied parent_span_id over the open-span stack', () => {
    const stream = capture_stream()
    const logger = stderr_logger({ stream })

    const outer = logger.start_span('parallel', { id: 'par_1' })
    const child = logger.start_span('step', { id: 'a', parent_span_id: 'real-parent' })
    logger.end_span(child, { id: 'a' })
    logger.end_span(outer, { id: 'par_1' })

    const child_start = stream.lines().find((l) => l['span_id'] === child && l['kind'] === 'span_start')
    expect(child_start?.['parent_span_id']).toBe('real-parent')
    expect(child_start?.['parent_span_id']).not.toBe(outer)
  })

  it('defaults to process.stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const logger = stderr_logger()
      logger.record({ kind: 'ping' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({ kind: 'ping' })
    } finally {
      spy.mockRestore()
    }
  })

  it('never throws when the stream throws', () => {
    const logger = stderr_logger({
      stream: {
        write: () => {
          throw new Error('broken pipe')
        },
      },
    })

    expect(() => {
      logger.record({ kind: 'ping' })
      const id = logger.start_span('step', { id: 'a' })
      logger.end_span(id, { id: 'a' })
    }).not.toThrow()
  })
})
