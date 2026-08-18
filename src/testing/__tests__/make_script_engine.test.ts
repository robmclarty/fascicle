import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { aborted_error, rate_limit_error, schema_validation_error } from '#engine'
import type { StreamChunk, ToolCallRecord } from '#engine'
import { make_script_engine } from '../make_script_engine.js'

describe('make_script_engine', () => {
  it('consumes the queue strictly in call order', async () => {
    const engine = make_script_engine(['one', 'two', 'three'])
    expect((await engine.generate({ prompt: 'a' })).content).toBe('one')
    expect((await engine.generate({ prompt: 'b' })).content).toBe('two')
    expect((await engine.generate({ prompt: 'c' })).content).toBe('three')
  })

  it('treats an object with foreign keys as plain content, not a script entry', async () => {
    const fixture = { verdict: 'ship', confidence: 0.9 }
    const engine = make_script_engine([fixture])
    const result = await engine.generate<unknown>({ prompt: 'x' })
    expect(result.content).toBe(fixture)
  })

  it('unwraps { content } so colliding literal content can be scripted', async () => {
    const literal = { content: 'inner' }
    const engine = make_script_engine([{ content: literal }])
    const result = await engine.generate<unknown>({ prompt: 'x' })
    expect(result.content).toBe(literal)
  })

  it('passes tool_calls, finish_reason, and usage through from a script entry', async () => {
    const tool_call: ToolCallRecord = {
      id: 'call_1',
      name: 'lookup',
      input: { q: 'x' },
      output: { hits: 2 },
      duration_ms: 5,
      started_at: 0,
    }
    const engine = make_script_engine([
      {
        content: 'looked it up',
        tool_calls: [tool_call],
        finish_reason: 'length',
        usage: { input_tokens: 7, output_tokens: 11 },
      },
    ])
    const result = await engine.generate({ prompt: 'x' })
    expect(result.content).toBe('looked it up')
    expect(result.tool_calls).toEqual([tool_call])
    expect(result.finish_reason).toBe('length')
    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 11 })
  })

  it('throws the scripted error instead of answering, then resumes the queue', async () => {
    const scripted = new rate_limit_error('scripted 429', { retry_after_ms: 1 })
    const engine = make_script_engine([{ throw: scripted }, 'recovered'])
    const failure: unknown = await engine.generate({ prompt: 'x' }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(failure).toBe(scripted)
    expect(failure).toBeInstanceOf(rate_limit_error)
    expect((await engine.generate({ prompt: 'x' })).content).toBe('recovered')
  })

  it('throws on exhaustion naming scripted vs received counts, per extra call', async () => {
    const engine = make_script_engine(['only'])
    await engine.generate({ prompt: 'x' })
    await expect(engine.generate({ prompt: 'x' })).rejects.toThrow(
      'make_script_engine: script exhausted: 1 response(s) scripted, call 2 received',
    )
    await expect(engine.generate({ prompt: 'x' })).rejects.toThrow(
      'make_script_engine: script exhausted: 1 response(s) scripted, call 3 received',
    )
  })

  it('validates scripted content through the caller schema and returns the validated value', async () => {
    const engine = make_script_engine(['hi'])
    const result = await engine.generate({
      prompt: 'x',
      schema: z.string().transform((s) => s.toUpperCase()),
    })
    expect(result.content).toBe('HI')
  })

  it('throws schema_validation_error naming the scripted response index on failure', async () => {
    const engine = make_script_engine(['first ok', { content: { wrong: true } }])
    await engine.generate({ prompt: 'x' })
    const failure: unknown = await engine
      .generate({ prompt: 'x', schema: z.object({ ok: z.boolean() }) })
      .then(
        () => undefined,
        (err: unknown) => err,
      )
    expect(failure).toBeInstanceOf(schema_validation_error)
    if (!(failure instanceof schema_validation_error)) throw new Error('unreachable')
    expect(failure.message).toContain('make_script_engine: scripted response 1')
    expect(failure.schema_issues[0]?.path).toEqual(['ok'])
    expect(failure.raw_text).toBe(JSON.stringify({ wrong: true }))
  })

  it('emits a text chunk then a finish chunk carrying the entry finish_reason and usage', async () => {
    const chunks: StreamChunk[] = []
    const engine = make_script_engine([
      { content: 'streamed', finish_reason: 'length', usage: { input_tokens: 2, output_tokens: 3 } },
    ])
    await engine.generate({
      prompt: 'x',
      on_chunk: (chunk) => {
        chunks.push(chunk)
      },
    })
    expect(chunks).toEqual([
      { kind: 'text', text: 'streamed', step_index: 0 },
      { kind: 'finish', finish_reason: 'length', usage: { input_tokens: 2, output_tokens: 3 } },
    ])
  })

  it('throws aborted_error before consuming the queue when the signal is already aborted', async () => {
    const engine = make_script_engine(['kept'])
    const controller = new AbortController()
    controller.abort()
    await expect(engine.generate({ prompt: 'x', abort: controller.signal })).rejects.toBeInstanceOf(
      aborted_error,
    )
    expect((await engine.generate({ prompt: 'x' })).content).toBe('kept')
  })

  it('reports the default envelope and honors configured usage and model_id', async () => {
    const plain = make_script_engine(['x'])
    const result = await plain.generate({ prompt: 'x' })
    expect(result.usage).toEqual({ input_tokens: 40, output_tokens: 20 })
    expect(result.finish_reason).toBe('stop')
    expect(result.model_resolved).toEqual({ provider: 'stub', model_id: 'script' })
    expect(result.tool_calls).toEqual([])
    expect(result.steps).toEqual([])

    const tuned = make_script_engine(['x'], {
      usage: { input_tokens: 1, output_tokens: 2 },
      model_id: 'scripted-model',
    })
    const tuned_result = await tuned.generate({ prompt: 'x' })
    expect(tuned_result.usage).toEqual({ input_tokens: 1, output_tokens: 2 })
    expect(tuned_result.model_resolved).toEqual({ provider: 'stub', model_id: 'scripted-model' })
  })
})
