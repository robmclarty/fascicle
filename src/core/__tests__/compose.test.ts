import { describe, expect, it } from 'vitest'
import { compose } from '../compose.js'
import { parallel } from '../parallel.js'
import { run } from '../runner.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

describe('compose', () => {
  it('passes input through and returns inner output unchanged', async () => {
    const inner = sequence([
      step('add1', (n: number) => n + 1),
      step('double', (n: number) => n * 2),
    ])
    const flow = compose(inner, { name: 'my-flow' })
  
    const result = await run(flow, 1)
    expect(result).toBe(4)
  })

  it('opens a span labeled with the user-supplied name', async () => {
    const { logger, events } = recording_logger()
    const flow = compose(
      sequence([
        step('a', (x: number) => x + 1),
        step('b', (x: number) => x * 2),
      ]),
      { name: 'ensemble' },
    )
  
    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
  
    const span_starts = events.filter((e) => e.kind === 'span_start').map((e) => e['name'])
    expect(span_starts[0]).toBe('ensemble')
    expect(span_starts).toContain('sequence')
    expect(span_starts).toContain('step')
  })

  it('records error on span end when inner throws', async () => {
    const { logger, events } = recording_logger()
    const inner = step('boom', () => {
      throw new Error('inner failure')
    })
    const flow = compose(inner, { name: 'outer' })
  
    await expect(
      run(flow, undefined, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('inner failure')
  
    const ends = events.filter((e) => e.kind === 'span_end')
    const compose_end = ends.find(
      (e) => typeof e['error'] === 'string' && e['error'] === 'inner failure',
    )
    expect(compose_end).toBeDefined()
  })

  it('keeps the display name out of the id', () => {
    const flow = compose(step('inner', (x: number) => x), { name: 'my pattern' })
    expect(flow.id).toMatch(/^compose_\d+$/)
    expect(flow.config?.['display_name']).toBe('my pattern')
  })

  it('exposes the inner step in children for describe()', () => {
    const inner = parallel({ a: step('a', (x: number) => x), b: step('b', (x: number) => x) })
    const flow = compose(inner, { name: 'ensemble' })
    expect(flow.children).toEqual([inner])
    expect(flow.kind).toBe('compose')
  })

  it('rejects empty name at construction time', () => {
    expect(() => compose(step('x', (n: number) => n), { name: '' })).toThrow(
      'compose(inner, { name }): name must be a non-empty string',
    )
  })

  it('rejects a missing options object at construction time', () => {
    const missing = undefined as unknown as { name: string }
    expect(() => compose(step('x', (n: number) => n), missing)).toThrow(/non-empty string/)
  })

  it('preserves children spans nested inside the compose span', async () => {
    const { logger, events } = recording_logger()
    const flow = compose(
      parallel({ left: step('l', (x: number) => x + 1), right: step('r', (x: number) => x - 1) }),
      { name: 'pattern' },
    )
  
    await run(flow, 10, { trajectory: logger, install_signal_handlers: false })
  
    const labels = events
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string)
    const compose_idx = labels.indexOf('pattern')
    const parallel_idx = labels.indexOf('parallel')
    expect(compose_idx).toBeGreaterThanOrEqual(0)
    expect(parallel_idx).toBeGreaterThan(compose_idx)
  })
})
