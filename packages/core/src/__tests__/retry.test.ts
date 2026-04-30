import { describe, expect, it } from 'vitest'
import { retry } from '../retry.js'
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

describe('retry', () => {
  it('throws twice then succeeds with max_attempts 3 (spec §10 test 5)', async () => {
    let calls = 0
    const errors: number[] = []
    const inner = step('flaky', (_: number) => {
      calls += 1
      if (calls < 3) throw new Error(`attempt ${calls} failed`)
      return 'ok'
    })
  
    const flow = retry(inner, {
      max_attempts: 3,
      backoff_ms: 1,
      on_error: (_err, attempt) => {
        errors.push(attempt)
      },
    })
  
    const result = await run(flow, 0, { install_signal_handlers: false })
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(errors).toEqual([1, 2])
  })

  it('observes exponential backoff between attempts', async () => {
    let calls = 0
    const marks: number[] = []
    const inner = step('flaky', (_: number) => {
      marks.push(Date.now())
      calls += 1
      if (calls < 3) throw new Error('fail')
      return 'ok'
    })
  
    const flow = retry(inner, { max_attempts: 3, backoff_ms: 20 })
  
    await run(flow, 0, { install_signal_handlers: false })
  
    expect(marks.length).toBe(3)
    const first_gap = (marks[1] ?? 0) - (marks[0] ?? 0)
    const second_gap = (marks[2] ?? 0) - (marks[1] ?? 0)
    expect(first_gap).toBeGreaterThanOrEqual(18)
    expect(second_gap).toBeGreaterThanOrEqual(38)
  })

  it('rethrows the last error if all attempts fail', async () => {
    let calls = 0
    const inner = step('always_fail', (_: number) => {
      calls += 1
      throw new Error(`attempt ${calls}`)
    })
  
    const flow = retry(inner, { max_attempts: 2, backoff_ms: 1 })
  
    await expect(run(flow, 0, { install_signal_handlers: false })).rejects.toThrow('attempt 2')
    expect(calls).toBe(2)
  })

  it('wraps inner execution in a retry span', async () => {
    const { logger, events } = recording_logger()
    const flow = retry(step('ok', (x: number) => x), { max_attempts: 1 })
  
    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
  
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'retry')
    expect(start).toBeDefined()
    const end = events.find((e) => e.kind === 'span_end' && e['span_id'] === start?.['span_id'])
    expect(end).toBeDefined()
    expect(end?.['error']).toBeUndefined()
  })

  it('records error on span_end when all attempts fail', async () => {
    const { logger, events } = recording_logger()
    const flow = retry(
      step('bad', () => {
        throw new Error('boom')
      }),
      { max_attempts: 1 },
    )
  
    await expect(
      run(flow, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('boom')
  
    const retry_end = events.find(
      (e) => e.kind === 'span_end' && typeof e['error'] === 'string' && e['error'] === 'boom',
    )
    expect(retry_end).toBeDefined()
  })

  it('accumulates cleanup handlers across attempts, LIFO (criterion 28, F11)', async () => {
    const fired: number[] = []
    let attempt = 0
    const inner = step('attempt', (_: number, ctx) => {
      attempt += 1
      const n = attempt
      ctx.on_cleanup(() => {
        fired.push(n)
      })
      if (attempt < 3) throw new Error(`fail ${attempt}`)
      return 'ok'
    })
  
    const flow = retry(inner, { max_attempts: 3, backoff_ms: 1 })
  
    const result = await run(flow, 0, { install_signal_handlers: false })
    expect(result).toBe('ok')
    expect(fired).toEqual([3, 2, 1])
  })
})
