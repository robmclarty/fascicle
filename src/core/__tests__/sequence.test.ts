import { afterEach, describe, expect, it } from 'vitest'
import { aborted_error } from '../errors.js'
import { run } from '../runner.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import type { Step } from '../types.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'
import { remove_signal_listeners } from '../../../test/fixtures/signal_listeners.js'

const double_fn = (x: number): number => x * 2

/**
 * Mimics model_step's shape for the compile-time joint tests: generic over
 * its output with a default and no inference site in the arguments, union
 * input.
 */
function fake_model_leaf<T = string>(): Step<string | readonly string[], T> {
  return step('leaf', (input: string | readonly string[]) => String(input) as unknown as T)
}

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
        'sequence(children): children must be an array of Steps, got object — sequence takes a single array, e.g., sequence([a, b, c])',
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

  it('type-checks joints at compile time for literal tuples', () => {
    const to_len = step('to_len', (s: string) => s.length)
    const wants_deep = step('wants_deep', (x: { deep: { field: string } }) => Boolean(x.deep))

    // @ts-expect-error a number output cannot feed a step wanting a deep object
    sequence([to_len, wants_deep])

    // An inline generic leaf keeps its default under inference, so a valid
    // pipe types end to end through it.
    const typed = sequence([step('src', (n: number) => String(n)), fake_model_leaf(), to_len])
    const ok: Step<number, number> = typed
    // @ts-expect-error the pipe ends in a number, not a string
    const wrong: Step<number, string> = typed

    // A loose middle accepting unknown composes after any output.
    const loose_ok: Step<string, number> = sequence([
      to_len,
      step('loose', (x: unknown) => String(x)),
      to_len,
    ])

    // Width subtyping across a joint stays legal.
    const wide = step('wide', (s: string) => ({ a: s, b: s.length }))
    const narrow = step('narrow', (x: { a: string }) => x.a)
    const width_ok: Step<string, string> = sequence([wide, narrow])

    // A runtime-built homogeneous array hits the array overload and keeps
    // its element type instead of degrading to the unknown boundary.
    const dynamic: Array<Step<number, number>> = [step('inc', (n: number) => n + 1)]
    const dynamic_ok: Step<number, number> = sequence(dynamic)

    void ok
    void wrong
    void loose_ok
    void width_ok
    void dynamic_ok
    expect(true).toBe(true)
  })

  it('type-checks homogeneous runtime arrays as Step<T, T>', () => {
    const homog: Array<Step<number, number>> = [step('inc', (n: number) => n + 1)]
    const homog_seq = sequence(homog)
    const homog_ok: Step<number, number> = homog_seq

    // The sound input type is enforced end to end, so a wrong input no
    // longer compiles the way the old Step<unknown, unknown> degradation did.
    const rejects_wrong_input = () => {
      // @ts-expect-error a Step<number, number> sequence cannot run on a string
      return run(homog_seq, 'not a number')
    }

    // A heterogeneous runtime array has no checkable joints and no single T,
    // so it is rejected outright instead of degrading.
    const hetero: Array<Step<string, number>> = []
    // @ts-expect-error runtime arrays must be homogeneous Step<T, T>
    sequence(hetero)

    void homog_ok
    void rejects_wrong_input
    expect(true).toBe(true)
  })

  it('type-checks spread segments inside literal tuples', () => {
    const to_len = step('to_len', (s: string) => s.length)
    const to_str = step('to_str', (n: number) => String(n))
    const mids: Array<Step<number, number>> = [step('inc', (n: number) => n + 1)]

    // A sound mid-tuple spread compiles: the segment is checked as a
    // homogeneous self-composing block instead of being index-zipped, which
    // used to smear positions into unions and reject sound code.
    const mid_spread: Step<string, string> = sequence([to_len, ...mids, to_str])

    // The joint into the spread is still enforced: string self-loops cannot
    // follow a number output. The expected element resolves to the branded
    // SequenceJointMismatch, so the error names the joint and both types.
    const bad_mids: Array<Step<string, string>> = []
    // @ts-expect-error the spread segment cannot accept the number upstream
    sequence([to_len, ...bad_mids, to_len])

    // The joint out of the spread accounts for the empty-spread path: a step
    // accepting only the segment output but not the upstream is rejected.
    const widening: Array<Step<number, 5>> = []
    const wants_five = step('five', (n: 5) => n)
    // @ts-expect-error when the spread is empty a plain number flows through
    sequence([to_len, ...widening, wants_five])

    // A trailing spread compiles; the output degrades to unknown because the
    // last child is not statically known.
    const trailing: Step<string, unknown> = sequence([to_len, ...mids])

    // A leading spread has no fixed first element to anchor joint checking,
    // so it only compiles when fully homogeneous via the array overload.
    const leading: Step<number, number> = sequence([...mids, step('dbl', (n: number) => n * 2)])
    // @ts-expect-error a leading spread cannot end in a non-unifiable step
    sequence([...mids, to_str])

    void mid_spread
    void trailing
    void leading
    expect(true).toBe(true)
  })
})
