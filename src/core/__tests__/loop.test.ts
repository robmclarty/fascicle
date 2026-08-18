import { describe, expect, it } from 'vitest'
import { aborted_error } from '../errors.js'
import { loop } from '../loop.js'
import type { LoopOutcome } from '../loop.js'
import { run } from '../runner.js'
import { step } from '../step.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The pre-v0.11 result envelope, rebuilt through `finish`.
 *
 * `loop` returns whatever `finish` projects, so the shape callers used to get
 * unconditionally is now opt-in. The tests that assert against it are the ones
 * about the iteration rather than the projection.
 */
function envelope<state>(state: state, outcome: LoopOutcome): { value: state } & LoopOutcome {
  return { value: state, ...outcome }
}

describe('loop', () => {
  it('runs body to max_rounds when no guard is provided', async () => {
    const flow = loop({
      init: (n: number) => n,
      body: step('inc', (n: number) => n + 1),
      finish: envelope,
      max_rounds: 5,
    })

    const result = await run(flow, 0)
    expect(result.value).toBe(5)
    expect(result.converged).toBe(false)
    expect(result.rounds).toBe(5)
  })

  it('exits early when guard returns stop:true', async () => {
    const flow = loop({
      init: (n: number) => n,
      body: step('inc', (n: number) => n + 1),
      guard: step('check', (n: number) => ({ stop: n >= 3, state: n })),
      finish: envelope,
      max_rounds: 10,
    })

    const result = await run(flow, 0)
    expect(result.value).toBe(3)
    expect(result.converged).toBe(true)
    expect(result.rounds).toBe(3)
  })

  it('reports converged:false to finish when guard never stops within max_rounds', async () => {
    const flow = loop({
      init: (n: number) => n,
      body: step('inc', (n: number) => n + 1),
      guard: step('check', (n: number) => ({ stop: n >= 100, state: n })),
      finish: envelope,
      max_rounds: 4,
    })

    const result = await run(flow, 0)
    expect(result.value).toBe(4)
    expect(result.converged).toBe(false)
    expect(result.rounds).toBe(4)
  })

  it('returns what finish projects, with no envelope around it', async () => {
    const flow = loop<number, number, string>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => `n=${String(n)}`,
      max_rounds: 3,
    })

    expect(await run(flow, 0)).toBe('n=3')
  })

  it('hands the outcome to finish so a projection can fold in either field', async () => {
    const seen: LoopOutcome[] = []
    const summarize = (n: number, outcome: LoopOutcome): string => {
      seen.push(outcome)
      return `${String(n)}${outcome.converged ? ' (converged)' : ''} in ${String(outcome.rounds)}`
    }

    const converging = loop<number, number, string>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      guard: step('check', (n: number) => ({ stop: n >= 2, state: n })),
      finish: summarize,
      max_rounds: 9,
    })
    const exhausting = loop<number, number, string>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      guard: step('check', (n: number) => ({ stop: false, state: n })),
      finish: summarize,
      max_rounds: 3,
    })

    expect(await run(converging, 0)).toBe('2 (converged) in 2')
    expect(await run(exhausting, 0)).toBe('3 in 3')
    expect(seen).toEqual([
      { converged: true, rounds: 2 },
      { converged: false, rounds: 3 },
    ])
  })

  it('accepts a bare predicate guard and terminates identically to the step form', async () => {
    // Mirrors the step-form test above: same body, same threshold, so the
    // predicate shorthand must converge with the same value and round count.
    const flow = loop({
      init: (n: number) => n,
      body: step('inc', (n: number) => n + 1),
      guard: (n: number) => n >= 3,
      finish: envelope,
      max_rounds: 10,
    })

    const result = await run(flow, 0)
    expect(result.value).toBe(3)
    expect(result.converged).toBe(true)
    expect(result.rounds).toBe(3)
  })

  it('accepts an async predicate guard', async () => {
    const flow = loop({
      init: (n: number) => n,
      body: step('inc', (n: number) => n + 1),
      guard: async (n: number) => n >= 2,
      finish: envelope,
      max_rounds: 10,
    })

    const result = await run(flow, 0)
    expect(result.value).toBe(2)
    expect(result.converged).toBe(true)
    expect(result.rounds).toBe(2)
  })

  it('exhausts max_rounds when the predicate guard never stops', async () => {
    const flow = loop({
      init: (n: number) => n,
      body: step('inc', (n: number) => n + 1),
      guard: (n: number) => n >= 100,
      finish: envelope,
      max_rounds: 4,
    })

    const result = await run(flow, 0)
    expect(result.value).toBe(4)
    expect(result.converged).toBe(false)
    expect(result.rounds).toBe(4)
  })

  it('wraps a predicate guard as a step in children, id-scoped to the loop', () => {
    const flow = loop<number, number, number>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      guard: (n: number) => n >= 1,
      finish: (n) => n,
      max_rounds: 1,
    })
    expect(flow.children).toHaveLength(2)
    expect(flow.children?.[1]?.id).toBe(`${flow.id}_guard`)
  })

  it('guard can transform state', async () => {
    const flow = loop({
      init: (n: number) => ({ n, tag: 'init' }),
      body: step('inc', (s: { n: number; tag: string }) => ({ n: s.n + 1, tag: s.tag })),
      guard: step('mark', (s: { n: number; tag: string }) => ({
        stop: s.n >= 2,
        state: { n: s.n, tag: 'guarded' },
      })),
      finish: (s, outcome) => ({ value: `${s.tag}:${String(s.n)}`, ...outcome }),
      max_rounds: 5,
    })

    const result = await run(flow, 0)
    expect(result.value).toBe('guarded:2')
    expect(result.converged).toBe(true)
  })

  it('uses default span label "loop" when name is absent', async () => {
    const { logger, events } = recording_logger()
    const flow = loop<number, number, number>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => n,
      max_rounds: 1,
    })
  
    await run(flow, 0, { trajectory: logger, install_signal_handlers: false })
  
    const spans = events.filter((e) => e.kind === 'span_start').map((e) => e['name'])
    expect(spans[0]).toBe('loop')
  })

  it('uses the user-provided name as span label when given', async () => {
    const { logger, events } = recording_logger()
    const flow = loop<number, number, number>({
      name: 'feedback-loop',
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => n,
      max_rounds: 1,
    })
  
    await run(flow, 0, { trajectory: logger, install_signal_handlers: false })
  
    const spans = events.filter((e) => e.kind === 'span_start').map((e) => e['name'])
    expect(spans[0]).toBe('feedback-loop')
  })

  it('id is prefixed with name when provided', () => {
    const named = loop<number, number, number>({
      name: 'fb',
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => n,
      max_rounds: 1,
    })
    expect(named.id.startsWith('fb_')).toBe(true)
  
    const anon = loop<number, number, number>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => n,
      max_rounds: 1,
    })
    expect(anon.id.startsWith('loop_')).toBe(true)
  })

  it('clamps max_rounds to a minimum of 1', async () => {
    const flow = loop({
      init: (n: number) => n,
      body: step('inc', (n: number) => n + 1),
      finish: envelope,
      max_rounds: 0,
    })

    const result = await run(flow, 0)
    expect(result.rounds).toBe(1)
    expect(result.value).toBe(1)
  })

  it('propagates abort between rounds (criterion: ctx.abort honored)', async () => {
    const flow = loop<number, number, number>({
      init: (n) => n,
      body: step('slow', async (n: number, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.abort.aborted) {
            resolve()
            return
          }
          ctx.abort.addEventListener('abort', () => resolve(), { once: true })
        })
        return n + 1
      }),
      finish: (n) => n,
      max_rounds: 50,
    })
  
    const pending = run(flow, 0)
    await wait(20)
    process.emit('SIGINT')
  
    await expect(pending).rejects.toBeInstanceOf(aborted_error)
  })

  it('exposes body and guard in children', () => {
    const body = step('inc', (n: number) => n + 1)
    const guard = step('check', (n: number) => ({ stop: false, state: n }))
    const flow = loop<number, number, number>({
      init: (n) => n,
      body,
      guard,
      finish: (n) => n,
      max_rounds: 1,
    })
    expect(flow.children).toEqual([body, guard])
  })
})
