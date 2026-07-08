/**
 * Unit tests for generate.ts.
 *
 * Mocks the `ai` module at the boundary so orchestration, retry,
 * schema-repair, streaming, and abort paths are exercised without the real
 * Vercel AI SDK.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { StreamChunk } from '../types.js'
import {
  build_mock_ai_module,
  build_mock_registry_module,
  enqueue_generate_text,
  enqueue_generate_text_fn,
  enqueue_stream,
  make_no_object_generated_error,
  make_text_result,
  mock_state,
  reset_mock_state,
} from './fixtures/mock_ai.js'

vi.mock('ai', async () => build_mock_ai_module())
vi.mock('../providers/registry.js', async () => build_mock_registry_module())

import { create_engine } from '../create_engine.js'
import {
  aborted_error,
  model_required_error,
  on_chunk_error,
  provider_error,
  rate_limit_error,
  schema_validation_error,
  tool_approval_denied_error,
  tool_error,
} from '../errors.js'

function basic_engine() {
  return create_engine({ providers: { anthropic: { api_key: 'k' } } })
}

function mk_429_retry_after_0(): Error {
  return Object.assign(new Error('rate limited'), {
    statusCode: 429,
    responseHeaders: { 'retry-after': '0' },
  })
}

function mk_429(): Error {
  return Object.assign(new Error('rate limited'), { statusCode: 429 })
}

function mk_5xx(): Error {
  return Object.assign(new Error('server error'), { statusCode: 503 })
}

beforeEach(() => reset_mock_state())
afterEach(() => reset_mock_state())

describe('generate: plain paths', () => {
  it('returns a plain completion (C1)', async () => {
    enqueue_generate_text(make_text_result('hello'))
    const result = await basic_engine().generate({ model: 'claude-opus-4-8', prompt: 'hi' })
    expect(result.content).toBe('hello')
    expect(result.tool_calls).toEqual([])
    expect(result.steps).toHaveLength(1)
    expect(result.finish_reason).toBe('stop')
    expect(result.model_resolved).toEqual({
      provider: 'anthropic',
      model_id: 'claude-opus-4-8',
    })
  })

  it('accepts Message[] prompts and hoists leading system messages to the system option (C2)', async () => {
    enqueue_generate_text(make_text_result('ok'))
    await basic_engine().generate({
      model: 'claude-opus',
      system: 'be concise',
      prompt: [
        { role: 'system', content: 'you are a helper' },
        { role: 'user', content: 'hi' },
      ],
    })
    const params = mock_state.last_generate_text_params as {
      system?: string
      messages: Array<{ role: string; content: unknown }>
    }
    // The leading run of system messages (engine `system` + a leading system in
    // the prompt) is joined and delivered via the SDK's top-level `system`
    // option; no `role: 'system'` entry remains in `messages`.
    expect(params.system).toBe('be concise\n\nyou are a helper')
    expect(params.messages.some((m) => m.role === 'system')).toBe(false)
    expect(params.messages[0]?.role).toBe('user')
    expect(params.messages[0]?.content).toBe('hi')
  })

  it('hoists system to the top-level option so the SDK system-in-messages warning never fires', async () => {
    const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      enqueue_generate_text(make_text_result('ok'))
      await basic_engine().generate({
        model: 'claude-opus',
        system: 'you are a helper',
        prompt: 'hi',
      })
      const params = mock_state.last_generate_text_params as {
        system?: string
        messages: Array<{ role: string; content: unknown }>
      }
      // System content rides the top-level `system` option, never a
      // `role: 'system'` message — the latter is what trips the AI SDK's
      // "System messages in the prompt or messages fields..." warning.
      expect(params.system).toBe('you are a helper')
      expect(params.messages.some((m) => m.role === 'system')).toBe(false)
      const warned_system = warn_spy.mock.calls.some((call) =>
        call.some(
          (arg) => typeof arg === 'string' && arg.includes('System messages in the prompt'),
        ),
      )
      expect(warned_system).toBe(false)
    } finally {
      warn_spy.mockRestore()
    }
  })
})

describe('generate: model + provider pass-through', () => {
  it('passes the model verbatim as model_id to the chosen provider (C24)', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const result = await basic_engine().generate({ model: 'claude-sonnet-4-6', prompt: 'x' })
    expect(result.model_resolved).toEqual({
      provider: 'anthropic',
      model_id: 'claude-sonnet-4-6',
    })
  })

  it('does not parse a colon in the model id; it rides through verbatim (C25)', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { ollama: { base_url: 'http://localhost:11434' } },
    })
    const result = await engine.generate({ model: 'qwen3-coder:30b', prompt: 'x' })
    expect(result.model_resolved).toEqual({ provider: 'ollama', model_id: 'qwen3-coder:30b' })
  })

  it('throws model_required_error when no model and no default is set', async () => {
    await expect(basic_engine().generate({ prompt: 'x' })).rejects.toBeInstanceOf(
      model_required_error,
    )
  })

  it('forwards temperature, max_tokens, and top_p to the SDK params', async () => {
    enqueue_generate_text(make_text_result('ok'))
    await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      temperature: 0.4,
      max_tokens: 256,
      top_p: 0.9,
    })
    const params = mock_state.last_generate_text_params as {
      temperature?: number
      maxOutputTokens?: number
      topP?: number
    }
    expect(params.temperature).toBe(0.4)
    expect(params.maxOutputTokens).toBe(256)
    expect(params.topP).toBe(0.9)
  })

  it('omits sampling params from the SDK call when not provided', async () => {
    enqueue_generate_text(make_text_result('ok'))
    await basic_engine().generate({ model: 'claude-opus', prompt: 'x' })
    const params = mock_state.last_generate_text_params as Record<string, unknown>
    expect('temperature' in params).toBe(false)
    expect('maxOutputTokens' in params).toBe(false)
    expect('topP' in params).toBe(false)
  })
})

describe('generate: structured output', () => {
  it('parses valid JSON when schema is set (C3)', async () => {
    enqueue_generate_text(make_text_result('{"n": 42}'))
    const schema = z.object({ n: z.number() })
    const result = await basic_engine().generate({ model: 'claude-opus', prompt: 'x', schema })
    expect(result.content).toEqual({ n: 42 })
  })

  it('runs one repair attempt and succeeds (C4)', async () => {
    enqueue_generate_text(make_text_result('not json'))
    enqueue_generate_text(make_text_result('{"n": 7}'))
    const schema = z.object({ n: z.number() })
    const result = await basic_engine().generate({ model: 'claude-opus', prompt: 'x', schema })
    expect(result.content).toEqual({ n: 7 })
    expect(result.steps).toHaveLength(2)
  })

  it('throws schema_validation_error when repair exhausts (C5)', async () => {
    enqueue_generate_text(make_text_result('not json'))
    enqueue_generate_text(make_text_result('still not json'))
    const schema = z.object({ n: z.number() })
    await expect(
      basic_engine().generate({ model: 'claude-opus', prompt: 'x', schema }),
    ).rejects.toBeInstanceOf(schema_validation_error)
  })
})

describe('generate: native structured output', () => {
  function ollama_engine() {
    return create_engine({
      providers: { ollama: { base_url: 'http://localhost:11434' } },
    })
  }

  it('routes the schema through experimental_output for structured_output providers', async () => {
    enqueue_generate_text(make_text_result('{"n": 42}'))
    const schema = z.object({ n: z.number() })
    const result = await ollama_engine().generate({
      model: 'qwen2.5-coder:7b',
      prompt: 'x',
      schema,
    })
    expect(result.content).toEqual({ n: 42 })
    const params = mock_state.last_generate_text_params as {
      experimental_output?: { name?: string; schema?: unknown }
    }
    expect(params.experimental_output?.name).toBe('object')
    expect(params.experimental_output?.schema).toBe(schema)
  })

  it('omits experimental_output when no schema is requested', async () => {
    enqueue_generate_text(make_text_result('plain text'))
    const result = await ollama_engine().generate({
      model: 'qwen2.5-coder:7b',
      prompt: 'x',
    })
    expect(result.content).toBe('plain text')
    const params = mock_state.last_generate_text_params as Record<string, unknown>
    expect('experimental_output' in params).toBe(false)
  })

  it('omits experimental_output when tools are present (gated on no tools)', async () => {
    enqueue_generate_text(make_text_result('{"n": 1}'))
    const schema = z.object({ n: z.number() })
    const result = await ollama_engine().generate({
      model: 'qwen2.5-coder:7b',
      prompt: 'x',
      schema,
      tools: [
        {
          name: 'noop',
          description: 'never called',
          input_schema: z.object({}).passthrough(),
          execute: () => 'unused',
        },
      ],
    })
    expect(result.content).toEqual({ n: 1 })
    const params = mock_state.last_generate_text_params as Record<string, unknown>
    expect('experimental_output' in params).toBe(false)
  })

  it('recovers the raw text from NoObjectGeneratedError and parses it in one step', async () => {
    enqueue_generate_text(
      make_no_object_generated_error({
        text: '{"n": 9}',
        finishReason: 'stop',
        usage: { inputTokens: 4, outputTokens: 2 },
      }),
    )
    const schema = z.object({ n: z.number() })
    const result = await ollama_engine().generate({
      model: 'qwen2.5-coder:7b',
      prompt: 'x',
      schema,
    })
    expect(result.content).toEqual({ n: 9 })
    expect(result.steps).toHaveLength(1)
    expect(mock_state.generate_text_call_count).toBe(1)
  })

  it('recovers from NoObjectGeneratedError into the repair loop', async () => {
    enqueue_generate_text(
      make_no_object_generated_error({
        text: 'garbage that the SDK could not parse',
        finishReason: 'stop',
        usage: { inputTokens: 4, outputTokens: 2 },
      }),
    )
    enqueue_generate_text(make_text_result('{"n": 5}'))
    const schema = z.object({ n: z.number() })
    const result = await ollama_engine().generate({
      model: 'qwen2.5-coder:7b',
      prompt: 'x',
      schema,
    })
    expect(result.content).toEqual({ n: 5 })
    expect(result.steps).toHaveLength(2)
    expect(mock_state.generate_text_call_count).toBe(2)
  })

  it('surfaces non-NoObjectGeneratedError failures unchanged', async () => {
    enqueue_generate_text(new Error('boom'))
    const schema = z.object({ n: z.number() })
    await expect(
      ollama_engine().generate({ model: 'qwen2.5-coder:7b', prompt: 'x', schema }),
    ).rejects.toThrow('boom')
  })
})

describe('generate: tool loop', () => {
  it('runs one tool round (C6)', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'echo', input: { v: 'hi' } }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 2 },
    })
    enqueue_generate_text(make_text_result('done'))
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      tools: [
        {
          name: 'echo',
          description: 'echoes input',
          input_schema: z.object({ v: z.string() }),
          execute: (input) => `echoed:${(input as { v: string }).v}`,
        },
      ],
    })
    expect(result.tool_calls).toHaveLength(1)
    expect(result.tool_calls[0]?.output).toBe('echoed:hi')
    expect(result.steps).toHaveLength(2)
  })

  it('salvages a tool call the provider emitted as text when repair is enabled', async () => {
    const seen: unknown[] = []
    enqueue_generate_text(
      make_text_result('<tool_call>{"name":"echo","arguments":{"v":"hi"}}</tool_call>'),
    )
    enqueue_generate_text(make_text_result('done'))
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      tool_call_repair_attempts: 1,
      tools: [
        {
          name: 'echo',
          description: 'echoes input',
          input_schema: z.object({ v: z.string() }),
          execute: (input) => {
            seen.push(input)
            return `echoed:${(input as { v: string }).v}`
          },
        },
      ],
    })
    expect(seen).toEqual([{ v: 'hi' }])
    expect(result.tool_calls).toHaveLength(1)
    expect(result.tool_calls[0]).toMatchObject({ salvaged: true, salvaged_format: 'hermes' })
    expect(result.tool_calls[0]?.output).toBe('echoed:hi')
  })

  it('leaves a text-emitted call inert when repair is disabled (default)', async () => {
    enqueue_generate_text(
      make_text_result('<tool_call>{"name":"echo","arguments":{"v":"hi"}}</tool_call>'),
    )
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      tools: [
        {
          name: 'echo',
          description: 'echoes input',
          input_schema: z.object({ v: z.string() }),
          execute: () => 'echoed',
        },
      ],
    })
    expect(result.tool_calls).toEqual([])
    expect(result.finish_reason).toBe('stop')
  })

  it('rejects a per-call max_tool_calls_per_step below 1', async () => {
    await expect(
      basic_engine().generate({ model: 'claude-opus', prompt: 'x', max_tool_calls_per_step: 0 }),
    ).rejects.toThrow(/max_tool_calls_per_step/)
  })

  it('shares the salvage budget across schema-repair iterations', async () => {
    // First loop salvages (budget 1 -> 0) then returns schema-invalid text;
    // the repair iteration returns markup again, which must NOT salvage a
    // second time because the budget is shared, not refilled per iteration.
    const seen: unknown[] = []
    enqueue_generate_text(
      make_text_result('<tool_call>{"name":"note","arguments":{"v":"one"}}</tool_call>'),
    )
    enqueue_generate_text(make_text_result('not json'))
    enqueue_generate_text(
      make_text_result('<tool_call>{"name":"note","arguments":{"v":"two"}}</tool_call>'),
    )
    enqueue_generate_text(make_text_result('still not json'))
    const schema = z.object({ n: z.number() })
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'x',
        schema,
        schema_repair_attempts: 1,
        tool_call_repair_attempts: 1,
        tools: [
          {
            name: 'note',
            description: 'notes input',
            input_schema: z.object({ v: z.string() }),
            execute: (input) => {
              seen.push(input)
              return 'noted'
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(schema_validation_error)
    expect(seen).toEqual([{ v: 'one' }])
  })

  it('hits max_steps with the attempted-but-unexecuted marker (C11)', async () => {
    const infinite = () => ({
      text: '',
      toolCalls: [
        { toolCallId: `c${mock_state.generate_text_call_count}`, toolName: 'loop', input: {} },
      ],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    enqueue_generate_text_fn(infinite)
    enqueue_generate_text_fn(infinite)
    enqueue_generate_text_fn(infinite)
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      max_steps: 3,
      tools: [
        {
          name: 'loop',
          description: 'loop',
          input_schema: z.object({}).passthrough(),
          execute: () => 'again',
        },
      ],
    })
    expect(result.finish_reason).toBe('max_steps')
    const last = result.tool_calls.at(-1)
    expect(last?.error?.message).toBe('max_steps_exceeded_before_execution')
  })

  it('under throw policy, a tool error bubbles out (C10)', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'boom', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'x',
        tool_error_policy: 'throw',
        tools: [
          {
            name: 'boom',
            description: 'fails',
            input_schema: z.object({}).passthrough(),
            execute: () => {
              throw new Error('kaboom')
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(tool_error)
  })
})

describe('generate: cost', () => {
  it('computes cost from default pricing (C29)', async () => {
    enqueue_generate_text({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 500 },
    })
    const result = await basic_engine().generate({ model: 'claude-sonnet-4-6', prompt: 'x' })
    expect(result.cost?.input_usd).toBeCloseTo(0.003, 6)
    expect(result.cost?.output_usd).toBeCloseTo(0.0075, 6)
    expect(result.cost?.total_usd).toBeCloseTo(0.0105, 6)
  })

  it('zero-cost for ollama without pricing (C33)', async () => {
    enqueue_generate_text({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    const engine = create_engine({
      providers: { ollama: { base_url: 'http://localhost:11434' } },
    })
    const result = await engine.generate({ model: 'ollama:gemma3:27b', prompt: 'x' })
    expect(result.cost).toEqual({
      total_usd: 0,
      input_usd: 0,
      output_usd: 0,
      currency: 'USD',
      is_estimate: true,
    })
  })

  it('user-overridden pricing applied (C34)', async () => {
    enqueue_generate_text({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 500 },
    })
    const engine = basic_engine()
    engine.register_price('anthropic', 'claude-opus-4-8', {
      input_per_million: 0,
      output_per_million: 0,
    })
    const result = await engine.generate({ model: 'claude-opus-4-8', prompt: 'x' })
    expect(result.cost?.total_usd).toBe(0)
  })

  it('cost with cache hits (C31)', async () => {
    enqueue_generate_text({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: {
        inputTokens: 1500,
        outputTokens: 200,
        cached_input_tokens: 1000,
      },
    })
    const result = await basic_engine().generate({ model: 'claude-sonnet-4-6', prompt: 'x' })
    expect(result.cost?.input_usd).toBeCloseTo(0.0015, 6)
    expect(result.cost?.cached_input_usd).toBeCloseTo(0.0003, 6)
    expect(result.cost?.output_usd).toBeCloseTo(0.003, 6)
  })

  it('partial usage fields omit cache keys (C35 / F17)', async () => {
    enqueue_generate_text({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    const engine = create_engine({
      providers: { openai: { api_key: 'k' } },
    })
    const result = await engine.generate({ model: 'gpt-4o', prompt: 'x' })
    expect(result.cost).toBeDefined()
    expect(result.cost?.cached_input_usd).toBeUndefined()
    expect(result.cost?.cache_write_usd).toBeUndefined()
    expect(result.cost?.reasoning_usd).toBeUndefined()
  })
})

describe('generate: streaming', () => {
  it('dispatches chunks in order (C13)', async () => {
    enqueue_stream([
      { type: 'text-delta', text: 'he' },
      { type: 'text-delta', text: 'llo' },
      {
        type: 'finish-step',
        finishReason: 'stop',
        usage: { inputTokens: 2, outputTokens: 1 },
      },
    ])
    const chunks: StreamChunk[] = []
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'hi',
      on_chunk: (c) => {
        chunks.push(c)
      },
    })
    const kinds = chunks.map((c) => c.kind)
    expect(kinds).toContain('text')
    expect(kinds.at(-1)).toBe('finish')
    const concatenated = chunks
      .filter((c) => c.kind === 'text')
      .map((c) => (c as { text: string }).text)
      .join('')
    expect(concatenated).toBe('hello')
    expect(result.content).toBe('hello')
  })

  it('aborts and wraps on_chunk failures (C15 / F11)', async () => {
    enqueue_stream([
      { type: 'text-delta', text: 'a' },
      { type: 'text-delta', text: 'b' },
      { type: 'text-delta', text: 'c' },
      {
        type: 'finish-step',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ])
    let count = 0
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        on_chunk: () => {
          count += 1
          if (count === 2) throw new Error('boom')
        },
      }),
    ).rejects.toBeInstanceOf(on_chunk_error)
  })

  it('does not retry after a chunk was delivered (C22)', async () => {
    enqueue_stream([
      { type: 'text-delta', text: 'partial' },
      { type: 'error', error: new Error('socket closed') },
    ])
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        on_chunk: () => {},
      }),
    ).rejects.toBeInstanceOf(provider_error)
    expect(mock_state.stream_text_call_count).toBe(1)
  })
})

describe('generate: retry', () => {
  it('retries a 429 and succeeds on the third attempt (C19)', async () => {
    enqueue_generate_text(mk_429_retry_after_0())
    enqueue_generate_text(mk_429_retry_after_0())
    enqueue_generate_text(make_text_result('ok'))
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'hi',
      retry: {
        max_attempts: 3,
        initial_delay_ms: 1,
        max_delay_ms: 5,
        retry_on: ['rate_limit', 'provider_5xx', 'network'],
      },
    })
    expect(result.content).toBe('ok')
    expect(mock_state.generate_text_call_count).toBe(3)
  })

  it('exhausts and throws rate_limit_error (C21)', async () => {
    enqueue_generate_text(mk_429())
    enqueue_generate_text(mk_429())
    enqueue_generate_text(mk_429())
    enqueue_generate_text(mk_429())
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        retry: {
          max_attempts: 3,
          initial_delay_ms: 1,
          max_delay_ms: 5,
          retry_on: ['rate_limit', 'provider_5xx', 'network'],
        },
      }),
    ).rejects.toBeInstanceOf(rate_limit_error)
  })

  it('5xx retries and surfaces provider_error after exhaustion (F4)', async () => {
    enqueue_generate_text(mk_5xx())
    enqueue_generate_text(mk_5xx())
    enqueue_generate_text(mk_5xx())
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        retry: {
          max_attempts: 3,
          initial_delay_ms: 1,
          max_delay_ms: 5,
          retry_on: ['rate_limit', 'provider_5xx', 'network'],
        },
      }),
    ).rejects.toBeInstanceOf(provider_error)
  })
})

describe('generate: abort', () => {
  it('throws aborted_error synchronously on a pre-aborted signal (C16)', async () => {
    const controller = new AbortController()
    controller.abort(new Error('pre'))
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        abort: controller.signal,
      }),
    ).rejects.toBeInstanceOf(aborted_error)
    expect(mock_state.generate_text_call_count).toBe(0)
    expect(mock_state.stream_text_call_count).toBe(0)
  })
})

describe('generate: HITL', () => {
  it('fails closed without on_tool_approval (F20)', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'do', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'x',
        tools: [
          {
            name: 'do',
            description: 'requires approval',
            input_schema: z.object({}).passthrough(),
            needs_approval: true,
            execute: () => 'done',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(tool_approval_denied_error)
  })

  it('tool_approval_denied feeds back under feed_back policy (F18)', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'do', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    enqueue_generate_text(make_text_result('recovered'))
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      on_tool_approval: () => false,
      tools: [
        {
          name: 'do',
          description: 'requires approval',
          input_schema: z.object({}).passthrough(),
          needs_approval: true,
          execute: () => 'should not run',
        },
      ],
    })
    expect(result.content).toBe('recovered')
    expect(result.tool_calls[0]?.error?.message).toBe('tool_approval_denied')
  })
})

describe('generate: provider_options merge', () => {
  it('passes user provider_options through to the SDK (was silently dropped)', async () => {
    enqueue_generate_text(make_text_result('ok'))
    await basic_engine().generate({
      model: 'sonnet',
      prompt: 'hi',
      provider_options: { anthropic: { customKey: 1 } },
    })
    const params = mock_state.last_generate_text_params as {
      providerOptions?: Record<string, unknown>
    }
    expect(params.providerOptions).toEqual({ anthropic: { customKey: 1 } })
  })

  it('passes effort translation through when no user options are given', async () => {
    enqueue_generate_text(make_text_result('ok'))
    await basic_engine().generate({ model: 'sonnet', prompt: 'hi', effort: 'medium' })
    const params = mock_state.last_generate_text_params as {
      providerOptions?: Record<string, unknown>
    }
    expect(params.providerOptions).toEqual({ anthropic: { effort: 'medium' } })
  })

  it('merges user options over effort translation, user winning on inner-key conflict', async () => {
    enqueue_generate_text(make_text_result('ok'))
    await basic_engine().generate({
      model: 'sonnet',
      prompt: 'hi',
      effort: 'medium',
      provider_options: { anthropic: { custom: true, effort: 'override' } },
    })
    const params = mock_state.last_generate_text_params as {
      providerOptions?: Record<string, Record<string, unknown>>
    }
    expect(params.providerOptions).toEqual({ anthropic: { effort: 'override', custom: true } })
  })
})
