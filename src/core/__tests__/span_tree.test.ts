import { describe, expect, it } from 'vitest'
import { parallel } from '../parallel.js'
import { run } from '../runner.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

describe('span tree parentage', () => {
  it('parents every span to its structural parent, including concurrent siblings', async () => {
    const { logger, events } = recording_logger()
    const flow = sequence([
      parallel({
        a: step('a', (x: number) => x),
        b: step('b', (x: number) => x),
      }),
    ])

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })

    const starts = events.filter((e) => e.kind === 'span_start')
    const seq = starts.find((e) => e['name'] === 'sequence')
    const par = starts.find((e) => e['name'] === 'parallel')
    const step_spans = starts.filter((e) => e['name'] === 'step')

    expect(seq?.['parent_span_id']).toBeUndefined()
    expect(par?.['parent_span_id']).toBe(seq?.['span_id'])
    expect(step_spans).toHaveLength(2)
    for (const s of step_spans) {
      expect(s['parent_span_id']).toBe(par?.['span_id'])
    }
  })
})
