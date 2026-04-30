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
  make_text_result,
  mock_state,
  reset_mock_state,
} from '../../test/fixtures/mock_ai.js'

vi.mock('ai', async () => build_mock_ai_module())
vi.mock('../providers/registry.js', async () => build_mock_registry_module())

import { create_engine } from '../create_engine.js'
import {
  aborted_error,
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
    const result = await basic_engine().generate({ model: 'claude-opus', prompt: 'hi' })
    expect(result.content).toBe('hello')
    expect(result.tool_calls).toEqual([])
    expect(result.steps).toHaveLength(1)
    expect(result.finish_reason).toBe('stop')
    expect(result.model_resolved).toEqual({
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
    })
  })

  it('accepts Message[] prompts and prepends the system option (C2)', async () => {
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
      messages: Array<{ role: string; content: unknown }>
    }
    expect(params.messages[0]?.role).toBe('system')
    expect(params.messages[0]?.content).toBe('be concise')
    expect(params.messages[1]?.role).toBe('system')
    expect(params.messages[1]?.content).toBe('you are a helper')
    expect(params.messages[2]?.role).toBe('user')
  })
})

describe('generate: alias and provider', () => {
  it('resolves a default alias (C24)', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const result = await basic_engine().generate({ model: 'sonnet', prompt: 'x' })
    expect(result.model_resolved.model_id).toBe('claude-sonnet-4-6')
  })

  it('provider-prefix bypass bypasses the alias table (C25)', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { ollama: { base_url: 'http://localhost:11434' } },
    })
    const result = await engine.generate({ model: 'ollama:gemma3:27b', prompt: 'x' })
    expect(result.model_resolved).toEqual({ provider: 'ollama', model_id: 'gemma3:27b' })
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
    const result = await basic_engine().generate({ model: 'sonnet', prompt: 'x' })
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
    engine.register_price('anthropic', 'claude-opus-4-7', {
      input_per_million: 0,
      output_per_million: 0,
    })
    const result = await engine.generate({ model: 'claude-opus', prompt: 'x' })
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
    const result = await basic_engine().generate({ model: 'sonnet', prompt: 'x' })
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
