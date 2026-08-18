import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { aborted_error, schema_validation_error } from '#engine'
import type { StreamChunk } from '#engine'
import { make_stub_engine } from '../make_stub_engine.js'
import type { StubContentFn } from '../make_stub_engine.js'

describe('make_stub_engine', () => {
  it('routes by system-prompt prefix, first match wins', async () => {
    const engine = make_stub_engine([
      { prefix: 'app/review', content: 'review answer' },
      { prefix: 'app/rev', content: 'shorter prefix, later entry' },
      { prefix: 'app/plan', content: 'plan answer' },
    ])
    const reviewed = await engine.generate({ prompt: 'x', system: 'app/review\nrest of prompt' })
    expect(reviewed.content).toBe('review answer')
    const planned = await engine.generate({ prompt: 'x', system: 'app/plan' })
    expect(planned.content).toBe('plan answer')
  })

  it('the empty prefix matches every call, including a missing system', async () => {
    const engine = make_stub_engine([{ prefix: '', content: 'always' }])
    const with_system = await engine.generate({ prompt: 'x', system: 'anything at all' })
    expect(with_system.content).toBe('always')
    const without_system = await engine.generate({ prompt: 'x' })
    expect(without_system.content).toBe('always')
  })

  it('throws on an unmatched system, naming the system in the message', async () => {
    const engine = make_stub_engine([{ prefix: 'app/known', content: 'x' }])
    await expect(engine.generate({ prompt: 'x', system: 'app/unknown' })).rejects.toThrow(
      "make_stub_engine: no canned response for system: app/unknown",
    )
    await expect(engine.generate({ prompt: 'x' })).rejects.toThrow(
      'make_stub_engine: no canned response for system: (none)',
    )
  })

  it('validates canned content through the caller schema and returns the validated value', async () => {
    const engine = make_stub_engine([{ prefix: 'app/upper', content: 'hi' }])
    const result = await engine.generate({
      prompt: 'x',
      system: 'app/upper',
      schema: z.string().transform((s) => s.toUpperCase()),
    })
    expect(result.content).toBe('HI')
  })

  it('throws when canned content fails the caller schema, naming the prefix', async () => {
    const engine = make_stub_engine([{ prefix: 'app/typed', content: { wrong: true } }])
    await expect(
      engine.generate({ prompt: 'x', system: 'app/typed', schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toThrow(
      "make_stub_engine: canned response for prefix 'app/typed' failed the caller's schema",
    )
  })

  it('throws the engine schema_validation_error carrying the issues and raw text', async () => {
    const engine = make_stub_engine([{ prefix: 'app/typed', content: { wrong: true } }])
    const failure: unknown = await engine
      .generate({ prompt: 'x', system: 'app/typed', schema: z.object({ ok: z.boolean() }) })
      .then(
        () => undefined,
        (err: unknown) => err,
      )
    expect(failure).toBeInstanceOf(schema_validation_error)
    if (!(failure instanceof schema_validation_error)) throw new Error('unreachable')
    expect(failure.kind).toBe('schema_validation_error')
    expect(failure.schema_issues.length).toBeGreaterThan(0)
    expect(failure.schema_issues[0]?.path).toEqual(['ok'])
    expect(failure.raw_text).toBe(JSON.stringify({ wrong: true }))
    expect(failure.message).toContain('ok:')
  })

  it('calls function content with the routed options and a per-route call index', async () => {
    const seen: Array<{ prompt: unknown; call_index: number }> = []
    const looped: StubContentFn = (opts, call_index) => {
      seen.push({ prompt: opts.prompt, call_index })
      return `round ${call_index}`
    }
    const engine = make_stub_engine([
      { prefix: 'app/loop', content: looped },
      { prefix: '', content: 'static' },
    ])
    const first = await engine.generate({ prompt: 'p1', system: 'app/loop' })
    expect(first.content).toBe('round 0')
    const other = await engine.generate({ prompt: 'p2', system: 'app/other' })
    expect(other.content).toBe('static')
    const second = await engine.generate({ prompt: 'p3', system: 'app/loop' })
    expect(second.content).toBe('round 1')
    expect(seen).toEqual([
      { prompt: 'p1', call_index: 0 },
      { prompt: 'p3', call_index: 1 },
    ])
  })

  it('validates function content through the caller schema like static content', async () => {
    const engine = make_stub_engine([
      { prefix: '', content: (_opts: unknown, call_index: number) => ({ round: call_index }) },
    ])
    const result = await engine.generate({
      prompt: 'x',
      schema: z.object({ round: z.number() }),
    })
    expect(result.content).toEqual({ round: 0 })
  })

  it('emits the content as a text chunk then a finish chunk when on_chunk is provided', async () => {
    const chunks: StreamChunk[] = []
    const engine = make_stub_engine([{ prefix: '', content: 'hello' }])
    const result = await engine.generate({
      prompt: 'x',
      on_chunk: (chunk) => {
        chunks.push(chunk)
      },
    })
    expect(chunks).toEqual([
      { kind: 'text', text: 'hello', step_index: 0 },
      { kind: 'finish', finish_reason: 'stop', usage: { input_tokens: 40, output_tokens: 20 } },
    ])
    expect(result.content).toBe('hello')
  })

  it('serializes non-string content as JSON in the emitted text chunk', async () => {
    const chunks: StreamChunk[] = []
    const engine = make_stub_engine([{ prefix: '', content: { verdict: 'ship' } }])
    await engine.generate<unknown>({
      prompt: 'x',
      on_chunk: (chunk) => {
        chunks.push(chunk)
      },
    })
    expect(chunks[0]).toEqual({ kind: 'text', text: '{"verdict":"ship"}', step_index: 0 })
  })

  it('throws aborted_error when the signal is already aborted, carrying the reason', async () => {
    const engine = make_stub_engine([{ prefix: '', content: 'x' }])
    const controller = new AbortController()
    const cause = new Error('user cancelled')
    controller.abort(cause)
    const failure: unknown = await engine
      .generate({ prompt: 'x', abort: controller.signal })
      .then(
        () => undefined,
        (err: unknown) => err,
      )
    expect(failure).toBeInstanceOf(aborted_error)
    if (!(failure instanceof aborted_error)) throw new Error('unreachable')
    expect(failure.reason).toBe(cause)
  })

  it('returns raw content unchanged when the call carries no schema', async () => {
    const canned = { deep: { value: 7 } }
    const engine = make_stub_engine([{ prefix: '', content: canned }])
    const result = await engine.generate<unknown>({ prompt: 'x' })
    expect(result.content).toBe(canned)
  })

  it('reports the default usage, finish reason, and model resolution envelope', async () => {
    const engine = make_stub_engine([{ prefix: '', content: 'x' }])
    const result = await engine.generate({ prompt: 'x' })
    expect(result.usage).toEqual({ input_tokens: 40, output_tokens: 20 })
    expect(result.finish_reason).toBe('stop')
    expect(result.model_resolved).toEqual({ provider: 'stub', model_id: 'stub' })
    expect(result.tool_calls).toEqual([])
    expect(result.steps).toEqual([])
  })

  it('honors configured usage and model_id on every result', async () => {
    const engine = make_stub_engine([{ prefix: '', content: 'x' }], {
      usage: { input_tokens: 3, output_tokens: 5 },
      model_id: 'app-canned',
    })
    const result = await engine.generate({ prompt: 'x' })
    expect(result.usage).toEqual({ input_tokens: 3, output_tokens: 5 })
    expect(result.model_resolved).toEqual({ provider: 'stub', model_id: 'app-canned' })
  })

  it('fills the inert engine members: pricing no-ops, dispose, with_providers throws', async () => {
    const engine = make_stub_engine([])
    expect(engine.resolve_price('p', 'm')).toBeUndefined()
    expect(engine.list_prices()).toEqual({})
    engine.register_price('p', 'm', { input_per_million: 1, output_per_million: 2 })
    expect(engine.list_prices()).toEqual({})
    expect(() => engine.with_providers({})).toThrow(
      'testing engines do not support with_providers',
    )
    await expect(engine.dispose()).resolves.toBeUndefined()
  })
})
