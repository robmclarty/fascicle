import { describe, expect, it } from 'vitest'
import { run } from '../runner.js'
import { step } from '../step.js'
import { STREAMING_HIGH_WATER_MARK } from '../streaming.js'
import type { TrajectoryEvent } from '../types.js'

describe('run.stream', () => {
  it('produces the same final result as run()', async () => {
    const emitting_step = step('emit_then_return', async (x: number, ctx) => {
      ctx.emit({ kind: 'token', text: 'hello' })
      ctx.emit({ kind: 'token', text: 'world' })
      return x * 2
    })
  
    const direct = await run(emitting_step, 3)
    const handle = run.stream(emitting_step, 3)
    const streamed = await handle.result
  
    expect(streamed).toBe(direct)
  })

  it('delivers events in emission order', async () => {
    const s = step('sequence', async (x: number, ctx) => {
      ctx.emit({ kind: 'token', text: 'a' })
      ctx.emit({ kind: 'token', text: 'b' })
      ctx.emit({ kind: 'token', text: 'c' })
      return x
    })
  
    const handle = run.stream(s, 0)
    const tokens: string[] = []
    const collector = (async () => {
      for await (const ev of handle.events) {
        if (ev.kind === 'emit' && typeof ev['text'] === 'string') {
          tokens.push(ev['text'])
        }
      }
    })()
  
    await handle.result
    await collector
  
    expect(tokens).toEqual(['a', 'b', 'c'])
  })

  it('resolves an already-waiting consumer when a new event arrives', async () => {
    const slow = step('slow', async (_: number, ctx) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      ctx.emit({ text: 'late' })
      return 1
    })
  
    const handle = run.stream(slow, 0)
    const iterator = handle.events[Symbol.asyncIterator]()
    const next_promise = iterator.next()
    await handle.result
    const result = await next_promise
    expect(result.done).toBe(false)
  })

  it('bounds buffered events at the high-water mark and records events_dropped', async () => {
    const N = 15_000
    const s = step('flood', async (_: number, ctx) => {
      for (let i = 0; i < N; i += 1) {
        ctx.emit({ kind: 'token', idx: i })
      }
      return N
    })
  
    const handle = run.stream(s, 0)
    const final = await handle.result
    expect(final).toBe(N)
  
    const collected: TrajectoryEvent[] = []
    for await (const ev of handle.events) {
      collected.push(ev)
    }
  
    const dropped_marker = collected.find((ev) => ev.kind === 'events_dropped')
    expect(dropped_marker).toBeDefined()
    expect(dropped_marker?.['count']).toBeGreaterThan(0)
    expect(collected.length).toBeLessThanOrEqual(STREAMING_HIGH_WATER_MARK + 1)
  })
})
