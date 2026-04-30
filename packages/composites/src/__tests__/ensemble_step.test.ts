import { run, step } from '@repo/core'
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core'
import { describe, expect, it } from 'vitest'
import { ensemble_step } from '../ensemble_step.js'

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

describe('ensemble_step (composite)', () => {
  it('runs members in parallel, dispatches score Step per result, picks max', async () => {
    let score_calls = 0
    const flow = ensemble_step<number, number, number>({
      members: {
        a: step('a', (x: number) => x + 1),
        b: step('b', (x: number) => x + 5),
        c: step('c', (x: number) => x + 3),
      },
      score: step('score', (value: number) => {
        score_calls += 1
        return value
      }),
      rank_by: (s) => s,
    })
  
    const result = await run(flow, 10, { install_signal_handlers: false })
    expect(result.winner_id).toBe('b')
    expect(result.winner).toBe(15)
    expect(result.winner_scored).toBe(15)
    expect(result.scored).toEqual({ a: 11, b: 15, c: 13 })
    expect(score_calls).toBe(3)
  })

  it('picks min when select is "min"', async () => {
    const flow = ensemble_step<unknown, number, number>({
      members: {
        a: step('a', () => 7),
        b: step('b', () => 3),
        c: step('c', () => 9),
      },
      score: step('score', (value: number) => value),
      rank_by: (s) => s,
      select: 'min',
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    expect(result.winner).toBe(3)
    expect(result.winner_scored).toBe(3)
  })

  it('preserves structured score output via rank_by projection', async () => {
    type Scored = { readonly value: number; readonly note: string }
    const flow = ensemble_step<unknown, string, Scored>({
      members: {
        a: step('a', () => 'apple'),
        b: step('b', () => 'banana'),
      },
      score: step(
        'score',
        (s: string): Scored => ({ value: s.length, note: `length=${String(s.length)}` }),
      ),
      rank_by: (s) => s.value,
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    expect(result.winner).toBe('banana')
    expect(result.winner_scored).toEqual({ value: 6, note: 'length=6' })
    expect(result.scored).toEqual({
      a: { value: 5, note: 'length=5' },
      b: { value: 6, note: 'length=6' },
    })
  })

  it('dispatches score as a Step with its own trajectory span', async () => {
    const { logger, events } = recording_logger()
    const flow = ensemble_step<unknown, number, number>({
      members: {
        a: step('a', () => 1),
        b: step('b', () => 2),
      },
      score: step('my_scorer', (v: number) => v),
      rank_by: (s) => s,
    })
  
    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false })
    const scorer_spans = events.filter(
      (e) => e.kind === 'span_start' && e['id'] === 'my_scorer',
    )
    expect(scorer_spans).toHaveLength(2)
  })

  it('wraps inner execution in an "ensemble_step" span', async () => {
    const { logger, events } = recording_logger()
    const flow = ensemble_step<unknown, number, number>({
      members: { a: step('a', () => 1) },
      score: step('s', (v: number) => v),
      rank_by: (s) => s,
    })
  
    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false })
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'ensemble_step')
    expect(start).toBeDefined()
  })

  it('honors a user-provided name override', async () => {
    const { logger, events } = recording_logger()
    const flow = ensemble_step<unknown, number, number>({
      name: 'best_of_n',
      members: { a: step('a', () => 1) },
      score: step('s', (v: number) => v),
      rank_by: (s) => s,
    })
  
    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false })
    const labels = events
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string)
    expect(labels).toContain('best_of_n')
    expect(labels).not.toContain('ensemble_step')
  })

  it('throws when constructed with zero members', () => {
    expect(() =>
      ensemble_step<unknown, number, number>({
        members: {},
        score: step('s', (v: number) => v),
        rank_by: (s) => s,
      }),
    ).toThrow('at least one member required')
  })

  it('propagates errors from a member step', async () => {
    const flow = ensemble_step<unknown, number, number>({
      members: {
        a: step('a', () => 1),
        b: step('b', () => {
          throw new Error('member b failed')
        }),
      },
      score: step('s', (v: number) => v),
      rank_by: (s) => s,
    })
  
    await expect(run(flow, undefined, { install_signal_handlers: false })).rejects.toThrow(
      'member b failed',
    )
  })

  it('propagates errors from the score step', async () => {
    const flow = ensemble_step<unknown, number, number>({
      members: { a: step('a', () => 1) },
      score: step('s', () => {
        throw new Error('scorer failed')
      }),
      rank_by: (s) => s,
    })
  
    await expect(run(flow, undefined, { install_signal_handlers: false })).rejects.toThrow(
      'scorer failed',
    )
  })
})
