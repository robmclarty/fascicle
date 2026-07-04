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

const double_fn = (n: number): number => n * 2

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

  it('exposes a pipe step shape with id, children, and config', () => {
    const inner = step('s', (x: number) => x)
    const flow = pipe(inner, double_fn, { name: 'adapt' })
    expect(flow.id).toMatch(/^pipe_\d+$/)
    expect(flow.kind).toBe('pipe')
    expect(flow.children).toEqual([inner])
    expect(flow.config?.['fn']).toBe(double_fn)
    expect(flow.config?.['display_name']).toBe('adapt')
  })

  it('omits display_name when no name is given', () => {
    const flow = pipe(
      step('s', (x: number) => x),
      (n: number) => n,
    )
    expect(flow.config !== undefined && 'display_name' in flow.config).toBe(false)
  })

  it('throws at construction when inner is not a Step', () => {
    expect(() => pipe('nope' as never, (n: number) => n)).toThrow(
      new TypeError('pipe(inner, fn): inner must be a Step, got string'),
    )
  })

  it('hints at step(fn) when inner is a plain function', () => {
    expect(() => pipe(double_fn as never, (n: number) => n)).toThrow(
      new TypeError('pipe(inner, fn): inner must be a Step, got function — wrap plain functions with step(fn)'),
    )
  })

  it('throws at construction when fn is not a function', () => {
    const inner = step('s', (x: number) => x)
    expect(() => pipe(inner, 'nope' as never)).toThrow(
      new TypeError('pipe(inner, fn): fn must be a function, got string'),
    )
  })

  it('hints at sequence when a Step is passed as fn (variadic misuse)', () => {
    const a = step('a', (x: number) => x + 1)
    const b = step('b', (x: number) => x * 2)
    expect(() => pipe(a, b as never)).toThrow(
      new TypeError(
        'pipe(inner, fn): fn must be a function, got a Step — pipe is not variadic; to chain Steps use sequence([...])',
      ),
    )
  })

  it('hints at sequence when a Step is passed as the third argument', () => {
    const a = step('a', (x: number) => x + 1)
    const c = step('c', (x: number) => x - 1)
    expect(() => pipe(a, (n: number) => n, c as never)).toThrow(
      new TypeError(
        'pipe(inner, fn, options): got a Step as the third argument — pipe is not variadic; to chain Steps use sequence([...])',
      ),
    )
  })
})
