import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core'
import { describe, expect, it } from 'vitest'
import { tee_logger } from '../tee.js'

function recording_logger(prefix: string): {
  logger: TrajectoryLogger
  events: TrajectoryEvent[]
} {
  const events: TrajectoryEvent[] = []
  let counter = 0
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push({ ...event, _via: prefix })
    },
    start_span: (name, meta) => {
      counter += 1
      const span_id = `${prefix}:${name}:${String(counter)}`
      events.push({ kind: 'span_start', span_id, name, ...meta, _via: prefix })
      return span_id
    },
    end_span: (id, meta) => {
      events.push({ kind: 'span_end', span_id: id, ...meta, _via: prefix })
    },
  }
  return { logger, events }
}

describe('tee_logger', () => {
  it('throws when no loggers are provided', () => {
    expect(() => tee_logger()).toThrow(/at least one logger/)
  })

  it('forwards record() to every sink', () => {
    const a = recording_logger('a')
    const b = recording_logger('b')
    const tee = tee_logger(a.logger, b.logger)

    tee.record({ kind: 'cost', total_usd: 0.5 })

    expect(a.events).toHaveLength(1)
    expect(b.events).toHaveLength(1)
    expect(a.events[0]).toMatchObject({ kind: 'cost', total_usd: 0.5, _via: 'a' })
    expect(b.events[0]).toMatchObject({ kind: 'cost', total_usd: 0.5, _via: 'b' })
  })

  it('returns the first sink id from start_span and translates back on end_span', () => {
    const a = recording_logger('a')
    const b = recording_logger('b')
    const tee = tee_logger(a.logger, b.logger)

    const id = tee.start_span('step', { id: 'foo' })

    expect(id).toBe('a:step:1')
    expect(a.events[0]).toMatchObject({ kind: 'span_start', span_id: 'a:step:1' })
    expect(b.events[0]).toMatchObject({ kind: 'span_start', span_id: 'b:step:1' })

    tee.end_span(id, { error: 'x' })
    expect(a.events[1]).toMatchObject({ kind: 'span_end', span_id: 'a:step:1', error: 'x' })
    expect(b.events[1]).toMatchObject({ kind: 'span_end', span_id: 'b:step:1', error: 'x' })
  })

  it('falls back to the supplied id when end_span is called without a matching start_span', () => {
    const a = recording_logger('a')
    const tee = tee_logger(a.logger)

    tee.end_span('unknown', {})
    expect(a.events[0]).toMatchObject({ kind: 'span_end', span_id: 'unknown' })
  })

  it('keeps fanning out when one sink throws', () => {
    const broken: TrajectoryLogger = {
      record: () => { throw new Error('boom') },
      start_span: () => { throw new Error('boom') },
      end_span: () => { throw new Error('boom') },
    }
    const good = recording_logger('good')
    const tee = tee_logger(broken, good.logger)

    tee.record({ kind: 'event', n: 1 })
    expect(good.events).toHaveLength(1)

    const id = tee.start_span('step', {})
    // canonical id falls back to the synthetic placeholder when first sink threw
    expect(id).toBeTypeOf('string')
    expect(good.events[1]).toMatchObject({ kind: 'span_start', name: 'step' })

    tee.end_span(id, {})
    expect(good.events[2]).toMatchObject({ kind: 'span_end' })
  })

  it('passes through unchanged with a single logger', () => {
    const a = recording_logger('a')
    const tee = tee_logger(a.logger)

    const id = tee.start_span('s', {})
    tee.end_span(id, {})
    expect(a.events).toHaveLength(2)
    expect(id).toBe('a:s:1')
  })
})
