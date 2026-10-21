import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { aborted_error, suspended_error } from '../errors.js'
import { parallel } from '../parallel.js'
import { run } from '../runner.js'
import { step } from '../step.js'
import { suspend } from '../suspend.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'
import { remove_signal_listeners } from '../../../test/fixtures/signal_listeners.js'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('parallel', () => {
  afterEach(remove_signal_listeners)

  it('takes an input that every member accepts, keeping a member union whole', async () => {
    // Mimics model_step beside a plain string step: one member takes a string,
    // the other a string or a list. The parallel's input must be a string.
    const by_text = step('by_text', (text: string) => text.length)
    const by_text_or_list = step('by_text_or_list', (input: string | readonly string[]) =>
      typeof input === 'string' ? input : input.join(' '),
    )
    const both = parallel({ length: by_text, joined: by_text_or_list })
    expect(await run(both, 'text', { install_signal_handlers: false })).toEqual({
      length: 4,
      joined: 'text',
    })
    // @ts-expect-error a list satisfies only one of the two members
    const rejects_list = () => run(both, ['a', 'b'])

    // One member accepts either of two shapes, the other wants a flag. Any
    // input with the flag and either shape satisfies both.
    const either = step('either', (input: { a: number } | { b: string }) => ('a' in input ? input.a : input.b))
    const flagged = step('flagged', (input: { flag: boolean }) => input.flag)
    const pair = parallel({ either, flagged })
    expect(await run(pair, { a: 1, flag: true }, { install_signal_handlers: false })).toEqual({
      either: 1,
      flagged: true,
    })
    void rejects_list
  })

  it('runs two children concurrently', async () => {
    const flow = parallel({
      a: step('a', async (x: number) => {
        await wait(40)
        return x + 1
      }),
      b: step('b', async (x: number) => {
        await wait(40)
        return x * 2
      }),
    })
  
    const started = Date.now()
    const result = await run(flow, 3)
    const elapsed = Date.now() - started
  
    expect(result).toEqual({ a: 4, b: 6 })
    expect(elapsed).toBeLessThan(80)
  })

  it('wraps children in a parallel span', async () => {
    const { logger, events } = recording_logger()
    const flow = parallel({
      a: step('a', (x: number) => x),
      b: step('b', (x: number) => x),
    })
  
    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
  
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'parallel')
    expect(start).toBeDefined()
  })

  it('propagates abort to in-flight children, awaits all, rethrows', async () => {
    let a_aborted = false
    let b_aborted = false
    let a_settled = false
    let b_settled = false
  
    const flow = parallel({
      a: step('a', async (_: number, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.abort.aborted) {
            a_aborted = true
            resolve()
            return
          }
          ctx.abort.addEventListener(
            'abort',
            () => {
              a_aborted = true
              resolve()
            },
            { once: true },
          )
        })
        a_settled = true
        return 1
      }),
      b: step('b', async (_: number, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.abort.aborted) {
            b_aborted = true
            resolve()
            return
          }
          ctx.abort.addEventListener(
            'abort',
            () => {
              b_aborted = true
              resolve()
            },
            { once: true },
          )
        })
        b_settled = true
        return 2
      }),
    })
  
    const pending = run(flow, 0)
    await wait(20)
    process.emit('SIGINT')
  
    await expect(pending).rejects.toBeInstanceOf(aborted_error)
    expect(a_aborted).toBe(true)
    expect(b_aborted).toBe(true)
    expect(a_settled).toBe(true)
    expect(b_settled).toBe(true)
  })

  it('prefers a suspended_error over a sibling application error', async () => {
    const flow = parallel({
      bad: step('bad', (_: number) => {
        throw new Error('sibling failed')
      }),
      gate: suspend({
        id: 'g',
        on: async () => {},
        resume_schema: z.object({ ok: z.boolean() }),
        combine: (_: number, r) => (r.ok ? 1 : 0),
      }),
    })

    let caught: unknown
    try {
      await run(flow, 0, { install_signal_handlers: false })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(suspended_error)
  })

  it('propagates a single child error in declared order', async () => {
    const flow = parallel({
      ok: step('ok', (x: number) => x),
      bad: step('bad', (_: number) => {
        throw new Error('boom')
      }),
    })

    await expect(
      run(flow, 1, { install_signal_handlers: false }),
    ).rejects.toThrow('boom')
  })
})
