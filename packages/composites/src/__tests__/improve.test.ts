import { run, step } from '@repo/core'
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core'
import { describe, expect, it } from 'vitest'
import {
  improve,
  type Candidate,
  type ImproveRoundInput,
  type ScoredCandidate,
} from '../improve.js'

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

const seed_zero = step('seed', () => ({ content: 0, score: 0 }))

function constant_propose(value: number, proposer_id = 'p0') {
  return step(
    'propose',
    (_input: ImproveRoundInput<number>): Candidate<number> => ({
      content: value,
      proposer_id,
    }),
  )
}

function value_score() {
  return step(
    'score',
    (c: Candidate<number>): ScoredCandidate<number> => ({
      candidate: c,
      score: c.content,
      accepted: true,
    }),
  )
}

describe('improve (composite)', () => {
  it('threads seed result into first round propose call', async () => {
    let seen: ImproveRoundInput<number> | undefined
    const flow = improve<unknown, number>({
      seed: step('seed', () => ({ content: 5, score: 5 })),
      propose: step('propose', (input: ImproveRoundInput<number>) => {
        seen = input
        return { content: 5, proposer_id: 'p0' }
      }),
      score: value_score(),
      budget: { max_rounds: 1, patience: 5 },
    })
  
    await run(flow, undefined, { install_signal_handlers: false })
    expect(seen).toBeDefined()
    expect(seen?.parent).toBe(5)
    expect(seen?.parent_score).toBe(5)
    expect(seen?.round).toBe(1)
    expect(seen?.lessons).toEqual([])
  })

  it('accepts a strictly-better candidate and updates parent for next round', async () => {
    const round_inputs: Array<ImproveRoundInput<number>> = []
    let n = 0
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step('propose', (input: ImproveRoundInput<number>) => {
        round_inputs.push(input)
        n += 1
        return { content: n, proposer_id: 'p0' }
      }),
      score: value_score(),
      budget: { max_rounds: 3, patience: 5 },
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    expect(round_inputs[0]?.parent).toBe(0)
    expect(round_inputs[1]?.parent).toBe(1)
    expect(round_inputs[2]?.parent).toBe(2)
    expect(result.best).toEqual({ content: 3, score: 3 })
    expect(result.rounds_used).toBe(3)
  })

  it('rejects when scored.accepted is false even if score is higher', async () => {
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: constant_propose(10),
      score: step(
        'score',
        (c: Candidate<number>): ScoredCandidate<number> => ({
          candidate: c,
          score: 10,
          accepted: false,
          reason: 'gate_failed',
        }),
      ),
      budget: { max_rounds: 2, patience: 5 },
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    expect(result.best).toEqual({ content: 0, score: 0 })
    expect(result.history.every((h) => !h.accepted)).toBe(true)
  })

  it('rejects when score does not exceed parent_score + epsilon', async () => {
    const flow = improve<unknown, number>({
      seed: step('seed', () => ({ content: 5, score: 5 })),
      propose: constant_propose(7),
      score: step(
        'score',
        (c: Candidate<number>): ScoredCandidate<number> => ({
          candidate: c,
          score: 7,
          accepted: true,
        }),
      ),
      budget: { max_rounds: 2, patience: 5 },
      epsilon: 5,
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    expect(result.best.content).toBe(5)
    expect(result.history[0]?.accepted).toBe(false)
  })

  it('stops via plateau when rounds_since_progress reaches patience', async () => {
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: constant_propose(0),
      score: step(
        'score',
        (c: Candidate<number>): ScoredCandidate<number> => ({
          candidate: c,
          score: 0,
          accepted: true,
        }),
      ),
      budget: { max_rounds: 100, patience: 2 },
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    expect(result.stopped_by).toBe('plateau')
    expect(result.rounds_used).toBe(2)
  })

  it('returns stopped_by: budget when max_rounds is exhausted without progress', async () => {
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: constant_propose(0),
      score: step(
        'score',
        (c: Candidate<number>): ScoredCandidate<number> => ({
          candidate: c,
          score: 0,
          accepted: true,
        }),
      ),
      budget: { max_rounds: 3, patience: 99 },
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    expect(result.stopped_by).toBe('budget')
    expect(result.rounds_used).toBe(3)
  })

  it('records each round in history with round number, winner, and accepted flag', async () => {
    let n = 0
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step('propose', (_input: ImproveRoundInput<number>) => {
        n += 1
        return { content: n % 2 === 0 ? -1 : n, proposer_id: 'p0' }
      }),
      score: value_score(),
      budget: { max_rounds: 3, patience: 99 },
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    expect(result.history).toHaveLength(3)
    expect(result.history[0]).toEqual({
      round: 1,
      winner: { candidate: { content: 1, proposer_id: 'p0' }, score: 1, accepted: true },
      accepted: true,
    })
    expect(result.history[1]?.accepted).toBe(false)
    expect(result.history[1]?.round).toBe(2)
    expect(result.history[2]?.accepted).toBe(true)
  })

  it('wall-clock budget stops the loop with stopped_by: budget', async () => {
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step(
        'propose',
        async (_input: ImproveRoundInput<number>): Promise<Candidate<number>> => {
          await new Promise((resolve) => setTimeout(resolve, 15))
          return { content: 0, proposer_id: 'p0' }
        },
      ),
      score: value_score(),
      budget: { max_rounds: 100, max_wallclock_ms: 10, patience: 99 },
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    expect(result.stopped_by).toBe('budget')
    expect(result.rounds_used).toBeLessThan(100)
  })

  it('wraps inner execution in an "improve" span', async () => {
    const { logger, events } = recording_logger()
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: constant_propose(1),
      score: value_score(),
      budget: { max_rounds: 1, patience: 1 },
    })
  
    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false })
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'improve')
    expect(start).toBeDefined()
    const end = events.find(
      (e) => e.kind === 'span_end' && e['span_id'] === start?.['span_id'],
    )
    expect(end).toBeDefined()
    expect(end?.['error']).toBeUndefined()
  })

  it('fans out N proposers per round in parallel and picks the highest score', async () => {
    let propose_calls = 0
    const proposed_values: number[] = []
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step('propose', (_input: ImproveRoundInput<number>) => {
        propose_calls += 1
        const value = propose_calls * 10
        proposed_values.push(value)
        return { content: value, proposer_id: 'ignored' }
      }),
      score: value_score(),
      budget: { max_rounds: 1, patience: 5 },
      proposers_per_round: 3,
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    expect(propose_calls).toBe(3)
    expect(result.best.score).toBe(Math.max(...proposed_values))
    expect(result.history[0]?.winner.candidate.proposer_id).toMatch(/^p[0-2]$/)
  })

  it('overrides proposer_id with the kernel-assigned slot id', async () => {
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step('propose', () => ({
        content: 1,
        proposer_id: 'user_supplied_should_be_ignored',
      })),
      score: value_score(),
      budget: { max_rounds: 1, patience: 5 },
      proposers_per_round: 2,
    })
  
    const result = await run(flow, undefined, { install_signal_handlers: false })
    const ids = result.history[0]?.winner.candidate.proposer_id
    expect(ids).not.toBe('user_supplied_should_be_ignored')
    expect(ids).toMatch(/^p[01]$/)
  })

  it('accumulates lessons from rejected rounds and feeds them into next round propose input', async () => {
    const seen_lessons: Array<ReadonlyArray<{ readonly reason: string }>> = []
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step('propose', (input: ImproveRoundInput<number>) => {
        seen_lessons.push(input.lessons)
        return { content: 0, proposer_id: 'p0' }
      }),
      score: step(
        'score',
        (c: Candidate<number>): ScoredCandidate<number> => ({
          candidate: c,
          score: 0,
          accepted: true,
          reason: 'no_improvement',
        }),
      ),
      budget: { max_rounds: 3, patience: 99 },
    })
  
    await run(flow, undefined, { install_signal_handlers: false })
    expect(seen_lessons[0]).toEqual([])
    expect(seen_lessons[1]).toHaveLength(1)
    expect(seen_lessons[1]?.[0]).toMatchObject({ reason: 'no_improvement' })
    expect(seen_lessons[2]).toHaveLength(2)
  })

  it('does not record lessons when score reason is undefined', async () => {
    const seen_lessons: Array<ReadonlyArray<unknown>> = []
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step('propose', (input: ImproveRoundInput<number>) => {
        seen_lessons.push(input.lessons)
        return { content: 0, proposer_id: 'p0' }
      }),
      score: step(
        'score',
        (c: Candidate<number>): ScoredCandidate<number> => ({
          candidate: c,
          score: 0,
          accepted: true,
        }),
      ),
      budget: { max_rounds: 3, patience: 99 },
    })
  
    await run(flow, undefined, { install_signal_handlers: false })
    expect(seen_lessons[0]).toEqual([])
    expect(seen_lessons[1]).toEqual([])
    expect(seen_lessons[2]).toEqual([])
  })

  it('does not record lessons when round is accepted', async () => {
    let n = 0
    const seen_lessons: Array<ReadonlyArray<unknown>> = []
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step('propose', (input: ImproveRoundInput<number>) => {
        seen_lessons.push(input.lessons)
        n += 1
        return { content: n, proposer_id: 'p0' }
      }),
      score: step(
        'score',
        (c: Candidate<number>): ScoredCandidate<number> => ({
          candidate: c,
          score: c.content,
          accepted: true,
          reason: 'always_provided',
        }),
      ),
      budget: { max_rounds: 3, patience: 99 },
    })
  
    await run(flow, undefined, { install_signal_handlers: false })
    expect(seen_lessons[0]).toEqual([])
    expect(seen_lessons[1]).toEqual([])
    expect(seen_lessons[2]).toEqual([])
  })

  it('caps lessons at lessons_capacity (ring buffer)', async () => {
    const seen_lessons: Array<ReadonlyArray<unknown>> = []
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step('propose', (input: ImproveRoundInput<number>) => {
        seen_lessons.push(input.lessons)
        return { content: 0, proposer_id: 'p0' }
      }),
      score: step(
        'score',
        (c: Candidate<number>): ScoredCandidate<number> => ({
          candidate: c,
          score: 0,
          accepted: true,
          reason: 'fail',
        }),
      ),
      budget: { max_rounds: 5, patience: 99 },
      lessons_capacity: 2,
    })
  
    await run(flow, undefined, { install_signal_handlers: false })
    expect(seen_lessons.at(-1)).toHaveLength(2)
  })

  it('emits improve.round_start, improve.candidate, improve.accept/reject, improve.stop events', async () => {
    const { logger, events } = recording_logger()
    let n = 0
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step('propose', () => {
        n += 1
        return { content: n === 2 ? -1 : n, proposer_id: 'p0' }
      }),
      score: step(
        'score',
        (c: Candidate<number>): ScoredCandidate<number> => ({
          candidate: c,
          score: c.content,
          accepted: true,
          reason: c.content < 0 ? 'regressed' : 'ok',
        }),
      ),
      budget: { max_rounds: 3, patience: 99 },
    })
  
    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false })
  
    const round_starts = events.filter((e) => e.kind === 'improve.round_start')
    expect(round_starts).toHaveLength(3)
    expect(round_starts.map((e) => e['round'])).toEqual([1, 2, 3])
  
    const candidates = events.filter((e) => e.kind === 'improve.candidate')
    expect(candidates).toHaveLength(3)
    expect(candidates[0]?.['proposer_id']).toBe('p0')
  
    const accepts = events.filter((e) => e.kind === 'improve.accept')
    const rejects = events.filter((e) => e.kind === 'improve.reject')
    expect(accepts).toHaveLength(2)
    expect(rejects).toHaveLength(1)
    expect(rejects[0]?.['round']).toBe(2)
    expect(rejects[0]?.['reason']).toBe('regressed')
    expect(accepts[0]?.['delta']).toBe(1)
  
    const stops = events.filter((e) => e.kind === 'improve.stop')
    expect(stops).toHaveLength(1)
    expect(stops[0]?.['stopped_by']).toBe('budget')
    expect(stops[0]?.['rounds_used']).toBe(3)
  })

  it('records improve.candidate per proposer when fanned out', async () => {
    const { logger, events } = recording_logger()
    let call = 0
    const flow = improve<unknown, number>({
      seed: seed_zero,
      propose: step('propose', () => {
        call += 1
        return { content: call, proposer_id: 'ignored' }
      }),
      score: value_score(),
      budget: { max_rounds: 1, patience: 99 },
      proposers_per_round: 4,
    })
  
    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false })
  
    const candidates = events.filter((e) => e.kind === 'improve.candidate')
    expect(candidates).toHaveLength(4)
    const proposer_ids = candidates
      .map((e) => e['proposer_id'] as string)
      .toSorted((a, b) => a.localeCompare(b))
    expect(proposer_ids).toEqual(['p0', 'p1', 'p2', 'p3'])
  })

  it('honors a user-provided name override', async () => {
    const { logger, events } = recording_logger()
    const flow = improve<unknown, number>({
      name: 'amplify_v2',
      seed: seed_zero,
      propose: constant_propose(1),
      score: value_score(),
      budget: { max_rounds: 1, patience: 1 },
    })
  
    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false })
    const labels = events
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string)
    expect(labels).toContain('amplify_v2')
    expect(labels).not.toContain('improve')
  })
})
