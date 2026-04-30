import { describe, expect, it } from 'vitest'
import { fallback } from '../fallback.js'
import { run } from '../runner.js'
import { step } from '../step.js'
import type { TrajectoryEvent, TrajectoryLogger } from '../types.js'

function recording_logger(): { logger: TrajectoryLogger; events: TrajectoryEvent[] } {
  const events: TrajectoryEvent[] = []
  let id = 0
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push(event)
    },
    start_span: (name, meta) => {
      id += 1
      const span_id = `span_${id}`
      events.push({ kind: 'span_start', span_id, name, ...meta })
      return span_id
    },
    end_span: (span_id, meta) => {
      events.push({ kind: 'span_end', span_id, ...meta })
    },
  }
  return { logger, events }
}

describe('fallback', () => {
  it('runs backup with the same input when primary throws (spec §10 test 6)', async () => {
    let backup_input: number | undefined
    const primary = step('primary', (_: number) => {
      throw new Error('primary failed')
    })
    const backup = step('backup', (x: number) => {
      backup_input = x
      return `backup:${x}`
    })
  
    const flow = fallback(primary, backup)
    const result = await run(flow, 42, { install_signal_handlers: false })
  
    expect(result).toBe('backup:42')
    expect(backup_input).toBe(42)
  })

  it('returns primary result when primary succeeds', async () => {
    let backup_called = false
    const primary = step('primary', (x: number) => `primary:${x}`)
    const backup = step('backup', (x: number) => {
      backup_called = true
      return `backup:${x}`
    })
  
    const flow = fallback(primary, backup)
    const result = await run(flow, 1, { install_signal_handlers: false })
  
    expect(result).toBe('primary:1')
    expect(backup_called).toBe(false)
  })

  it('propagates backup error when both fail', async () => {
    const primary = step('primary', () => {
      throw new Error('primary failed')
    })
    const backup = step('backup', () => {
      throw new Error('backup failed')
    })
  
    const flow = fallback(primary, backup)
    await expect(run(flow, 0, { install_signal_handlers: false })).rejects.toThrow('backup failed')
  })

  it('wraps execution in a fallback span', async () => {
    const { logger, events } = recording_logger()
    const flow = fallback(step('p', (x: number) => x), step('b', (x: number) => x))
  
    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
  
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'fallback')
    expect(start).toBeDefined()
  })

  it('records error on span_end when both children fail', async () => {
    const { logger, events } = recording_logger()
    const flow = fallback(
      step('p', () => {
        throw new Error('p')
      }),
      step('b', () => {
        throw new Error('boom')
      }),
    )
  
    await expect(
      run(flow, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('boom')
  
    const fallback_end = events.find(
      (e) => e.kind === 'span_end' && typeof e['error'] === 'string' && e['error'] === 'boom',
    )
    expect(fallback_end).toBeDefined()
  })
})
