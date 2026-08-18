import { describe, expect, it } from 'vitest'
import type { GenerateResult } from '#engine'
import { make_capture_engine } from '../make_capture_engine.js'

describe('make_capture_engine', () => {
  it('records the GenerateOptions of every call, in order, in the live array', async () => {
    const { engine, calls } = make_capture_engine()
    await engine.generate({ prompt: 'first', system: 'a' })
    await engine.generate({ prompt: 'second', model: 'm' })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.prompt).toBe('first')
    expect(calls[0]?.system).toBe('a')
    expect(calls[1]?.prompt).toBe('second')
    expect(calls[1]?.model).toBe('m')
    calls.length = 0
    await engine.generate({ prompt: 'third' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toBe('third')
  })

  it('answers every call with the default canned result', async () => {
    const { engine } = make_capture_engine()
    const result = await engine.generate({ prompt: 'x' })
    expect(result).toEqual({
      content: 'ok',
      tool_calls: [],
      steps: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      finish_reason: 'stop',
      model_resolved: { provider: 'stub', model_id: 'capture' },
    })
  })

  it('answers with the configured result verbatim', async () => {
    const canned: GenerateResult<unknown> = {
      content: { verdict: 'ship' },
      tool_calls: [],
      steps: [],
      usage: { input_tokens: 9, output_tokens: 9 },
      finish_reason: 'stop',
      model_resolved: { provider: 'stub', model_id: 'custom' },
    }
    const { engine } = make_capture_engine({ result: canned })
    const result = await engine.generate<unknown>({ prompt: 'x' })
    expect(result).toBe(canned)
  })

  it('awaits on_generate with the recorded options before resolving', async () => {
    const order: string[] = []
    const { engine, calls } = make_capture_engine({
      on_generate: async (opts) => {
        await Promise.resolve()
        order.push(`generate:${typeof opts.prompt === 'string' ? opts.prompt : '(messages)'}`)
      },
    })
    const pending = engine.generate({ prompt: 'p' }).then(() => order.push('resolved'))
    expect(calls).toHaveLength(1)
    await pending
    expect(order).toEqual(['generate:p', 'resolved'])
  })

  it('hands on_generate the same options object it recorded', async () => {
    let seen: unknown
    const { engine, calls } = make_capture_engine({
      on_generate: (opts) => {
        seen = opts
      },
    })
    await engine.generate({ prompt: 'x' })
    expect(seen).toBe(calls[0])
  })

  it('fills the inert engine members: pricing no-ops, dispose, with_providers throws', async () => {
    const { engine } = make_capture_engine()
    expect(engine.resolve_price('p', 'm')).toBeUndefined()
    expect(engine.list_prices()).toEqual({})
    expect(() => engine.with_providers({})).toThrow(
      'testing engines do not support with_providers',
    )
    await expect(engine.dispose()).resolves.toBeUndefined()
  })
})
