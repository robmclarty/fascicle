import { describe, expect, it } from 'vitest'
import { parallel } from '../parallel.js'
import { run } from '../runner.js'
import { sequence } from '../sequence.js'
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

describe('runner timestamp stamping', () => {
  it('stamps every event with run_id and a numeric ts', async () => {
    const { logger, events } = recording_logger()
    const flow = sequence([
      step('a', (x: number, ctx) => {
        ctx.emit({ label: 'progress', value: x })
        return x + 1
      }),
      parallel({ b: step('b', (x: number) => x), c: step('c', (x: number) => x) }),
    ])

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })

    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      expect(typeof e['ts']).toBe('number')
      expect(typeof e['run_id']).toBe('string')
    }
  })

  it('does not overwrite a caller-supplied ts', async () => {
    const { logger, events } = recording_logger()
    const flow = step('emit_with_ts', (_: number, ctx) => {
      ctx.emit({ label: 'manual', ts: 42 })
      return 1
    })

    await run(flow, 0, { trajectory: logger, install_signal_handlers: false })

    const manual = events.find((e) => e['label'] === 'manual')
    expect(manual?.['ts']).toBe(42)
  })
})
