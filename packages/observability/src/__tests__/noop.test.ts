import { describe, expect, it } from 'vitest'
import { noop_logger } from '../noop.js'

describe('noop_logger', () => {
  it('returns an object satisfying the TrajectoryLogger contract', () => {
    const logger = noop_logger()
    expect(typeof logger.record).toBe('function')
    expect(typeof logger.start_span).toBe('function')
    expect(typeof logger.end_span).toBe('function')
  })

  it('record is a no-op and does not throw', () => {
    const logger = noop_logger()
    expect(() => {
      logger.record({ kind: 'anything', foo: 'bar' })
    }).not.toThrow()
  })

  it('start_span returns a non-empty string id', () => {
    const logger = noop_logger()
    const id = logger.start_span('step', { id: 'x' })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('end_span accepts the returned id without throwing', () => {
    const logger = noop_logger()
    const id = logger.start_span('step')
    expect(() => {
      logger.end_span(id, { id: 'x' })
    }).not.toThrow()
  })

  it('two sequential start_spans produce distinct ids', () => {
    const logger = noop_logger()
    const a = logger.start_span('a')
    const b = logger.start_span('b')
    expect(a).not.toBe(b)
  })
})
