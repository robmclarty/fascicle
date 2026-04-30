import { describe, expect, it } from 'vitest'
import { pipe } from '../pipe.js'
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

describe('pipe', () => {
  it('adapts output shape (spec §10 test 17)', async () => {
    const inner = step('count', (x: string) => x.length)
    const flow = pipe(inner, (n: number) => ({ count: n, doubled: n * 2 }))
  
    const result = await run(flow, 'hello')
    expect(result).toEqual({ count: 5, doubled: 10 })
  })

  it('supports async transform fn', async () => {
    const inner = step('inc', (x: number) => x + 1)
    const flow = pipe(inner, async (n: number) => `got:${n}`)
  
    await expect(run(flow, 4)).resolves.toBe('got:5')
  })

  it('emits a pipe span', async () => {
    const { logger, events } = recording_logger()
    const flow = pipe(
      step('s', (x: number) => x),
      (n: number) => n,
    )
  
    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
  
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'pipe')
    expect(start).toBeDefined()
  })

  it('rejects type-incompatible pipe at compile time', () => {
    const inner = step('n', (x: number) => x + 1)
    // @ts-expect-error pipe fn must accept the inner's output type (number), not string.
    const bad = pipe(inner, (s: string) => s.toUpperCase())
    expect(bad.kind).toBe('pipe')
  })
})
