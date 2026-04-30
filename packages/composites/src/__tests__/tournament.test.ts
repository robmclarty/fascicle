import { aborted_error, run, step } from '@repo/core'
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { tournament } from '../tournament.js'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

describe('tournament (composite)', () => {
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.off('SIGINT', l)
    for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l)
  })

  it('runs 3-match single-elimination bracket over four members (spec §10 test 11)', async () => {
    const flow = tournament({
      members: {
        a: step('a', () => ({ score: 1 })),
        b: step('b', () => ({ score: 4 })),
        c: step('c', () => ({ score: 2 })),
        d: step('d', () => ({ score: 3 })),
      },
      compare: (x, y) => (x.score > y.score ? 'a' : 'b'),
    })
  
    const result = await run(flow, 'input', { install_signal_handlers: false })
    expect(result.winner).toEqual({ score: 4 })
    expect(result.bracket.length).toBe(3)
    const rounds = result.bracket.map((r) => r.round)
    expect(rounds).toContain(1)
    expect(rounds).toContain(2)
  })

  it('records a bye for an odd member count', async () => {
    const flow = tournament({
      members: {
        a: step('a', () => ({ v: 10 })),
        b: step('b', () => ({ v: 5 })),
        c: step('c', () => ({ v: 7 })),
        d: step('d', () => ({ v: 3 })),
        e: step('e', () => ({ v: 1 })),
      },
      compare: (x, y) => (x.v > y.v ? 'a' : 'b'),
    })
  
    const result = await run(flow, 'input', { install_signal_handlers: false })
    expect(result.winner).toEqual({ v: 10 })
    const round_1_matches = result.bracket.filter((r) => r.round === 1)
    expect(round_1_matches.length).toBe(2)
  })

  it('propagates abort to in-flight members (criterion 26)', async () => {
    const aborts = new Set<string>()
  
    const make_slow = (id: string): ReturnType<typeof step<number, { id: string }>> =>
      step(id, async (_: number, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.abort.aborted) {
            aborts.add(id)
            resolve()
            return
          }
          ctx.abort.addEventListener(
            'abort',
            () => {
              aborts.add(id)
              resolve()
            },
            { once: true },
          )
        })
        return { id }
      })
  
    const flow = tournament({
      members: { a: make_slow('a'), b: make_slow('b') },
      compare: () => 'a',
    })
  
    const pending = run(flow, 0)
    await wait(20)
    process.emit('SIGINT')
  
    await expect(pending).rejects.toBeInstanceOf(aborted_error)
    expect(aborts.has('a')).toBe(true)
    expect(aborts.has('b')).toBe(true)
  })

  it('wraps execution in a "tournament" span', async () => {
    const { logger, events } = recording_logger()
    const flow = tournament({
      members: {
        a: step('a', () => 1),
        b: step('b', () => 2),
      },
      compare: () => 'a',
    })
  
    await run(flow, 'x', { trajectory: logger, install_signal_handlers: false })
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'tournament')
    expect(start).toBeDefined()
    const end = events.find((e) => e.kind === 'span_end' && e['span_id'] === start?.['span_id'])
    expect(end).toBeDefined()
    expect(end?.['error']).toBeUndefined()
  })

  it('honors a user-provided name override', async () => {
    const { logger, events } = recording_logger()
    const flow = tournament({
      name: 'bracket-runoff',
      members: {
        a: step('a', () => 1),
        b: step('b', () => 2),
      },
      compare: () => 'a',
    })
  
    await run(flow, 'x', { trajectory: logger, install_signal_handlers: false })
    const labels = events
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string)
    expect(labels).toContain('bracket-runoff')
    expect(labels).not.toContain('tournament')
  })
})
