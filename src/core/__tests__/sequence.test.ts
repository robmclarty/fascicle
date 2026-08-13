import { afterEach, describe, expect, it } from 'vitest'
import { aborted_error } from '../errors.js'
import { run } from '../runner.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'
import { remove_signal_listeners } from '../../../test/fixtures/signal_listeners.js'

const double_fn = (x: number): number => x * 2

describe('sequence', () => {
  afterEach(remove_signal_listeners)

  it('chains three adders in declared order (spec §10 test 2)', async () => {
    const flow = sequence([
      step('add1', (x: number) => x + 1),
      step('add2', (x: number) => x + 2),
      step('add3', (x: number) => x + 3),
    ])
  
    const result = await run(flow, 10)
    expect(result).toBe(16)
  })

  it('emits a sequence span wrapping children', async () => {
    const { logger, events } = recording_logger()
    const flow = sequence([
      step('a', (x: number) => x + 1),
      step('b', (x: number) => x * 2),
    ])
  
    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
  
    const spans = events.filter((e) => e.kind === 'span_start').map((e) => e['name'])
    expect(spans[0]).toBe('sequence')
    expect(spans).toContain('step')
  })

  it('honors a user-supplied name as the span label (universal name? contract)', async () => {
    const { logger, events } = recording_logger()
    const flow = sequence(
      [step('a', (x: number) => x + 1), step('b', (x: number) => x * 2)],
      { name: 'my-flow' },
    )
  
    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
  
    const spans = events.filter((e) => e.kind === 'span_start').map((e) => e['name'])
    expect(spans[0]).toBe('my-flow')
  })

  it('records error on span end when a child throws', async () => {
    const { logger, events } = recording_logger()
    const flow = sequence([
      step('ok', (x: number) => x + 1),
      step('fail', () => {
        throw new Error('boom')
      }),
    ])
  
    await expect(
      run(flow, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('boom')
  
    const ends = events.filter((e) => e.kind === 'span_end')
    const seq_end = ends.find((e) => typeof e['error'] === 'string' && e['error'] === 'boom')
    expect(seq_end).toBeDefined()
  })

  it('does not run the next child once the context is aborted', async () => {
    let second_ran = false
    const flow = sequence([
      step('first', (x: number) => {
        process.emit('SIGINT')
        return x + 1
      }),
      step('second', (x: number) => {
        second_ran = true
        return x + 1
      }),
    ])

    await expect(run(flow, 0)).rejects.toBeInstanceOf(aborted_error)
    expect(second_ran).toBe(false)
  })

  it('throws at construction when children is not an array (variadic misuse)', () => {
    const a = step('a', (x: number) => x + 1)
    expect(() => sequence(a as never)).toThrow(
      new TypeError(
        'sequence(children): children must be an array of Steps, got object — sequence takes a single array, e.g. sequence([a, b, c])',
      ),
    )
  })

  it('throws at construction with the index of a non-Step child', () => {
    const a = step('a', (x: number) => x + 1)
    expect(() => sequence([a, 'nope' as never])).toThrow(
      new TypeError('sequence(children): children[1] is not a Step, got string'),
    )
  })

  it('hints at step(fn) when a plain function is passed as a child', () => {
    const a = step('a', (x: number) => x + 1)
    expect(() => sequence([a, double_fn as never])).toThrow(
      new TypeError(
        'sequence(children): children[1] is not a Step, got function — wrap plain functions with step(fn), or use pipe(inner, fn) to transform output',
      ),
    )
  })
})
