/**
 * Unit tests for generate.ts.
 *
 * Mocks the `ai` module at the boundary so orchestration, retry,
 * schema-repair, streaming, and abort paths are exercised without the real
 * Vercel AI SDK.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ProviderInit, StreamChunk, Tool, TurnRequest, TurnResult } from '../types.js'
import {
  build_mock_ai_module,
  build_mock_registry_module,
  enqueue_generate_text,
  enqueue_generate_text_fn,
  enqueue_stream,
  enqueue_stream_script,
  make_text_result,
  mock_state,
  reset_mock_state,
} from './fixtures/mock_ai.js'

vi.mock('ai', async () => build_mock_ai_module())
vi.mock('../providers/registry.js', async () => build_mock_registry_module())

import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import type { ToolSchema } from '#schema'
// The engine zone may not import testing, since testing imports the engine;
// a test may, since nothing in the engine imports a test.
// fallow-ignore-next-line boundary-violation
import { make_loop_engine } from '#testing'
import { create_engine } from '../create_engine.js'
import { create_claude_cli_adapter } from '../providers/claude_cli/index.js'
import {
  default_normalize_usage,
  translate_effort_to_sdk_reasoning,
  type ProviderFactory,
} from '../providers/types.js'
import { create_anthropic_adapter } from '../providers/anthropic.js'
import { create_bedrock_adapter } from '../providers/bedrock.js'
import { create_google_adapter } from '../providers/google.js'
import { create_lmstudio_adapter } from '../providers/lmstudio.js'
import { create_ollama_adapter } from '../providers/ollama.js'
import { create_openai_adapter } from '../providers/openai.js'
import { create_openrouter_adapter } from '../providers/openrouter.js'
import {
  aborted_error,
  engine_config_error,
  incomplete_generation_error,
  model_required_error,
  on_chunk_error,
  provider_capability_error,
  provider_error,
  provider_required_error,
  rate_limit_error,
  schema_validation_error,
  tool_approval_denied_error,
  tool_error,
} from '../errors.js'

const SHOWN_N_SCHEMA =
  'You must respond with a single JSON value that conforms to this JSON Schema:\n\n' +
  '{"type":"object","properties":{"n":{"type":"number"}},"required":["n"],"additionalProperties":false}\n\n' +
  'Return ONLY the JSON value, with no markdown or commentary.'

const BARE_SCHEMA_REQUEST =
  'You must respond with a single JSON value that conforms to the expected schema. Return ONLY the JSON value, with no markdown or commentary.'

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
  it('returns a plain completion', async () => {
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

  it('accepts Message[] prompts and hoists leading system messages to the system option', async () => {
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
      instructions?: string
      messages: Array<{ role: string; content: unknown }>
    }
    // The leading run of system messages (engine `system` + a leading system in
    // the prompt) is joined and delivered via the SDK's top-level `instructions`
    // option; no `role: 'system'` entry remains in `messages`.
    expect(params.instructions).toBe('be concise\n\nyou are a helper')
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
        instructions?: string
        messages: Array<{ role: string; content: unknown }>
      }
      // System content rides the top-level `instructions` option, never a
      // `role: 'system'` message — the latter is what trips the AI SDK's
      // "System messages in the prompt or messages fields..." warning.
      expect(params.instructions).toBe('you are a helper')
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
  it('passes the model verbatim as model_id to the chosen provider', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const result = await basic_engine().generate({ model: 'claude-sonnet-4-6', prompt: 'x' })
    expect(result.model_resolved).toEqual({
      provider: 'anthropic',
      model_id: 'claude-sonnet-4-6',
    })
  })

  it('does not parse a colon in the model id; it rides through verbatim', async () => {
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

  it('disables the AI SDK internal retry on the generate call (maxRetries: 0)', async () => {
    enqueue_generate_text(make_text_result('ok'))
    await basic_engine().generate({ model: 'claude-opus', prompt: 'x' })
    const params = mock_state.last_generate_text_params as { maxRetries?: number }
    expect(params.maxRetries).toBe(0)
  })

  it('disables the AI SDK internal retry on the stream call (maxRetries: 0)', async () => {
    enqueue_stream([
      { type: 'text-delta', text: 'ok' },
      { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ])
    await basic_engine().generate({ model: 'claude-opus', prompt: 'x', on_chunk: () => {} })
    const params = mock_state.last_stream_text_params as { maxRetries?: number }
    expect(params.maxRetries).toBe(0)
  })
})

function make_recorder(): { logger: TrajectoryLogger; events: TrajectoryEvent[] } {
  const events: TrajectoryEvent[] = []
  const logger: TrajectoryLogger = {
    record: (e) => events.push(e),
    start_span: () => 'span',
    end_span: () => {},
  }
  return { logger, events }
}

describe('generate: dispatch gating', () => {
  it('rejects an already-aborted signal before starting a generate span', async () => {
    const controller = new AbortController()
    controller.abort(new Error('pre-aborted'))
    const spans: string[] = []
    const logger: TrajectoryLogger = {
      record: () => {},
      start_span: (name) => {
        spans.push(name)
        return 's'
      },
      end_span: () => {},
    }
    let err: unknown
    try {
      await basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        abort: controller.signal,
        trajectory: logger,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    expect(((err as aborted_error).reason as Error).message).toBe('pre-aborted')
    // The upfront guard throws before options resolve or a span opens. A false
    // guard or emptied block falls through to run_tool_loop's own abort check,
    // but only after a generate span has been started (and error-ended).
    expect(spans).toHaveLength(0)
    expect(mock_state.generate_text_call_count).toBe(0)
  })

  it('throws provider_capability_error naming schema when the adapter lacks schema support', async () => {
    mock_state.capability_overrides['anthropic'] = { schema: false }
    let err: unknown
    try {
      await basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        schema: z.object({ a: z.string() }),
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_capability_error)
    expect((err as provider_capability_error).capability).toBe('schema')
    expect(mock_state.generate_text_call_count).toBe(0)
  })

  it('throws provider_capability_error naming tools when the adapter lacks tool support', async () => {
    mock_state.capability_overrides['anthropic'] = { tools: false }
    let err: unknown
    try {
      await basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        tools: [
          {
            name: 't',
            description: 'd',
            input_schema: z.object({}),
            execute: () => 'x',
          },
        ],
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_capability_error)
    expect((err as provider_capability_error).capability).toBe('tools')
    expect(mock_state.generate_text_call_count).toBe(0)
  })

  it('throws provider_capability_error naming streaming when the adapter lacks streaming support', async () => {
    mock_state.capability_overrides['anthropic'] = { streaming: false }
    let err: unknown
    try {
      await basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        on_chunk: () => {},
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_capability_error)
    expect((err as provider_capability_error).capability).toBe('streaming')
  })

  it('does not gate a schema-free call on an adapter that lacks schema support', async () => {
    mock_state.capability_overrides['anthropic'] = { schema: false }
    enqueue_generate_text(make_text_result('ok'))
    // No schema in the call: the `opts.schema !== undefined` guard must stay
    // false rather than throwing 'schema' for a plain completion.
    const result = await basic_engine().generate({ model: 'claude-opus', prompt: 'hi' })
    expect(result.content).toBe('ok')
  })

  it('does not gate a tool-free call on an adapter that lacks tool support', async () => {
    mock_state.capability_overrides['anthropic'] = { tools: false }
    enqueue_generate_text(make_text_result('ok'))
    // No tools in the call: the `tools_list.length > 0` guard must be a strict
    // gt, not a ge that would misfire on the empty list and throw 'tools'.
    const result = await basic_engine().generate({ model: 'claude-opus', prompt: 'hi' })
    expect(result.content).toBe('ok')
  })

  it('rejects a non-positive turn_timeout_ms with the exact message', async () => {
    let err: unknown
    try {
      await basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        turn_timeout_ms: 0,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(engine_config_error)
    expect((err as engine_config_error).message).toBe('turn_timeout_ms must be > 0, got 0')
  })

  it('accepts a positive turn_timeout_ms and completes normally', async () => {
    enqueue_generate_text(make_text_result('ok'))
    // A valid budget must pass the `turn_timeout_ms <= 0` gate untouched; a
    // forced-true gate would reject every call as a config error.
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'hi',
      turn_timeout_ms: 5_000,
    })
    expect(result.content).toBe('ok')
  })

  it('applies the engine default_system when the call provides none', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { anthropic: { api_key: 'k' } },
      defaults: { system: 'house style' },
    })
    await engine.generate({ model: 'claude-opus', prompt: 'hi' })
    const params = mock_state.last_generate_text_params as { instructions?: string }
    expect(params.instructions).toBe('house style')
  })

  it('lets a call-level system override the engine default_system', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { anthropic: { api_key: 'k' } },
      defaults: { system: 'house style' },
    })
    await engine.generate({ model: 'claude-opus', system: 'call style', prompt: 'hi' })
    const params = mock_state.last_generate_text_params as { instructions?: string }
    expect(params.instructions).toBe('call style')
  })

  it('applies the engine default sampling knobs when the call omits them', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { anthropic: { api_key: 'k' } },
      defaults: { temperature: 0.2, max_tokens: 128, top_p: 0.7 },
    })
    await engine.generate({ model: 'claude-opus', prompt: 'hi' })
    const params = mock_state.last_generate_text_params as {
      temperature?: number
      maxOutputTokens?: number
      topP?: number
    }
    expect(params.temperature).toBe(0.2)
    expect(params.maxOutputTokens).toBe(128)
    expect(params.topP).toBe(0.7)
  })

  it('lets call-level sampling knobs override the engine defaults', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { anthropic: { api_key: 'k' } },
      defaults: { temperature: 0.2, max_tokens: 128, top_p: 0.7 },
    })
    await engine.generate({
      model: 'claude-opus',
      prompt: 'hi',
      temperature: 0.9,
      max_tokens: 64,
      top_p: 0.5,
    })
    const params = mock_state.last_generate_text_params as {
      temperature?: number
      maxOutputTokens?: number
      topP?: number
    }
    expect(params.temperature).toBe(0.9)
    expect(params.maxOutputTokens).toBe(64)
    expect(params.topP).toBe(0.5)
  })

  it('throws provider_required_error when several providers are configured and none is chosen', async () => {
    const engine = create_engine({
      providers: { openai: { api_key: 'k' }, ollama: { base_url: 'http://x' } },
    })
    let err: unknown
    try {
      await engine.generate({ model: 'm', prompt: 'hi' })
    } catch (e) {
      err = e
    }
    // Two adapters -> no sole provider, no per-call provider, no default:
    // resolution has nothing to go on and must fail loud, naming what IS
    // configured rather than silently guessing a provider.
    expect(err).toBeInstanceOf(provider_required_error)
    expect((err as provider_required_error).message).toBe(
      'no provider specified: pass `provider` to generate() or set `defaults.provider` (configured: openai, ollama)',
    )
  })

  it('infers the sole configured provider when the call names none', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { openai: { api_key: 'k' } },
    })
    const result = await engine.generate({ model: 'gpt-4o', prompt: 'hi' })
    expect(result.model_resolved).toEqual({ provider: 'openai', model_id: 'gpt-4o' })
  })

  it('resolves via defaults.provider when several providers are configured', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { openai: { api_key: 'k' }, ollama: { base_url: 'http://x' } },
      defaults: { provider: 'ollama' },
    })
    const result = await engine.generate({ model: 'm', prompt: 'hi' })
    expect(result.model_resolved).toEqual({ provider: 'ollama', model_id: 'm' })
  })

  it('lets a per-call provider win over defaults.provider', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { openai: { api_key: 'k' }, ollama: { base_url: 'http://x' } },
      defaults: { provider: 'ollama' },
    })
    const result = await engine.generate({ model: 'm', provider: 'openai', prompt: 'hi' })
    expect(result.model_resolved).toEqual({ provider: 'openai', model_id: 'm' })
  })

  it('records effort_ignored when the provider drops the effort hint', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { ollama: { base_url: 'http://localhost:11434' } },
    })
    const { logger, events } = make_recorder()
    await engine.generate({
      model: 'gemma3:27b',
      prompt: 'hi',
      effort: 'high',
      trajectory: logger,
    })
    const ev = events.find((e) => e.kind === 'effort_ignored')
    expect(ev).toBeDefined()
    expect(ev?.['model_id']).toBe('gemma3:27b')
  })

  it('does not record effort_ignored when effort is none', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { ollama: { base_url: 'http://localhost:11434' } },
    })
    const { logger, events } = make_recorder()
    await engine.generate({
      model: 'gemma3:27b',
      prompt: 'hi',
      effort: 'none',
      trajectory: logger,
    })
    expect(events.find((e) => e.kind === 'effort_ignored')).toBeUndefined()
  })

  it('omits providerOptions from the SDK call when the merge is empty', async () => {
    enqueue_generate_text(make_text_result('ok'))
    // effort 'none' yields an empty translation and no user options, so the
    // combined merge is empty and provider_options resolves to undefined; a
    // forced-true guard would forward an empty {} object instead.
    await basic_engine().generate({ model: 'claude-opus', prompt: 'hi', effort: 'none' })
    const params = mock_state.last_generate_text_params as Record<string, unknown>
    expect('providerOptions' in params).toBe(false)
  })
})

describe('generate: structured output', () => {
  it('parses valid JSON when schema is set', async () => {
    enqueue_generate_text(make_text_result('{"n": 42}'))
    const schema = z.object({ n: z.number() })
    const result = await basic_engine().generate({ model: 'claude-opus', prompt: 'x', schema })
    expect(result.content).toEqual({ n: 42 })
  })

  it('runs one repair attempt and succeeds', async () => {
    enqueue_generate_text(make_text_result('not json'))
    enqueue_generate_text(make_text_result('{"n": 7}'))
    const schema = z.object({ n: z.number() })
    const result = await basic_engine().generate({ model: 'claude-opus', prompt: 'x', schema })
    expect(result.content).toEqual({ n: 7 })
    expect(result.steps).toHaveLength(2)
  })

  it('throws schema_validation_error when repair exhausts', async () => {
    enqueue_generate_text(make_text_result('not json'))
    enqueue_generate_text(make_text_result('still not json'))
    const schema = z.object({ n: z.number() })
    await expect(
      basic_engine().generate({ model: 'claude-opus', prompt: 'x', schema }),
    ).rejects.toBeInstanceOf(schema_validation_error)
  })

  it('returns the validated value for a schema that validates to undefined', async () => {
    enqueue_generate_text(make_text_result('"skip"'))
    const schema = z.string().transform(() => undefined)
    const result = await basic_engine().generate({ model: 'claude-opus', prompt: 'x', schema })
    expect(result.content).toBeUndefined()
  })

  it('throws incomplete_generation_error on a content_filter finish without attempting repair', async () => {
    enqueue_generate_text({ ...make_text_result('blocked'), finishReason: 'content-filter' })
    const schema = z.object({ n: z.number() })
    const err: unknown = await basic_engine()
      .generate({ model: 'claude-opus', prompt: 'x', schema })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(incomplete_generation_error)
    expect(err).not.toBeInstanceOf(schema_validation_error)
    const incomplete = err as incomplete_generation_error
    expect(incomplete.kind).toBe('incomplete_generation_error')
    expect(incomplete.finish_reason).toBe('content_filter')
    expect(incomplete.raw_text).toBe('blocked')
    expect(mock_state.generate_text_call_count).toBe(1)
  })

  it('throws incomplete_generation_error when the model stops on tool_calls with a schema set', async () => {
    enqueue_generate_text({
      text: 'stub',
      toolCalls: [],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    const schema = z.object({ n: z.number() })
    const err: unknown = await basic_engine()
      .generate({ model: 'claude-opus', prompt: 'x', schema })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(incomplete_generation_error)
    expect((err as incomplete_generation_error).finish_reason).toBe('tool_calls')
    expect((err as incomplete_generation_error).raw_text).toBe('stub')
  })

  it('throws incomplete_generation_error when the step cap ends a schema call', async () => {
    enqueue_generate_text_fn(infinite)
    enqueue_generate_text_fn(infinite)
    const schema = z.object({ n: z.number() })
    const err: unknown = await basic_engine()
      .generate({
        model: 'claude-opus',
        prompt: 'x',
        max_steps: 2,
        schema,
        tools: [
          {
            name: 'loop',
            description: 'loop',
            input_schema: z.object({}).passthrough(),
            execute: () => 'again',
          },
        ],
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(incomplete_generation_error)
    expect((err as incomplete_generation_error).finish_reason).toBe('max_steps')
    expect((err as incomplete_generation_error).raw_text).toBe('')
  })
})

function ollama_engine() {
  return create_engine({
    providers: { ollama: { base_url: 'http://localhost:11434' } },
  })
}

describe('generate: native structured output', () => {

  it('routes the schema through output for structured_output providers', async () => {
    enqueue_generate_text(make_text_result('{"n": 42}'))
    const schema = z.object({ n: z.number() })
    const result = await ollama_engine().generate({
      model: 'qwen2.5-coder:7b',
      prompt: 'x',
      schema,
    })
    expect(result.content).toEqual({ n: 42 })
    const params = mock_state.last_generate_text_params as {
      output?: { name?: string; schema?: unknown }
    }
    expect(params.output?.name).toBe('object')
    expect(params.output?.schema).toBe(schema)
  })

  it('omits output when no schema is requested', async () => {
    enqueue_generate_text(make_text_result('plain text'))
    const result = await ollama_engine().generate({
      model: 'qwen2.5-coder:7b',
      prompt: 'x',
    })
    expect(result.content).toBe('plain text')
    const params = mock_state.last_generate_text_params as Record<string, unknown>
    expect('output' in params).toBe(false)
  })

  it('omits output when tools are present (gated on no tools)', async () => {
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
    expect('output' in params).toBe(false)
  })

  it('parses a streamed structured reply itself, in one step', async () => {
    enqueue_generate_text(make_text_result('{"n": 9}', { input_tokens: 4, output_tokens: 2 }))
    const schema = z.object({ n: z.number() })
    const result = await ollama_engine().generate({
      model: 'qwen2.5-coder:7b',
      prompt: 'x',
      schema,
    })
    expect(result.content).toEqual({ n: 9 })
    expect(result.steps).toHaveLength(1)
    expect(result.usage).toStrictEqual({ input_tokens: 4, output_tokens: 2 })
    expect(mock_state.generate_text_call_count).toBe(1)
  })

  it('sends a streamed reply that misses the schema to the repair loop', async () => {
    // The SDK parses `output` only when it is read, and the transport never
    // reads it, so the reply reaches the engine's own parse and repair.
    enqueue_generate_text(make_text_result('garbage that misses the schema'))
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
    const repair = mock_state.last_generate_text_params as {
      messages: Array<{ role: string; content: unknown }>
      output?: { name?: string }
    }
    expect(repair.output?.name).toBe('object')
    expect(repair.messages.at(-2)).toMatchObject({ role: 'assistant', content: 'garbage that misses the schema' })
  })

  it('surfaces a failed structured turn unchanged', async () => {
    enqueue_generate_text(new Error('boom'))
    const schema = z.object({ n: z.number() })
    await expect(
      ollama_engine().generate({ model: 'qwen2.5-coder:7b', prompt: 'x', schema }),
    ).rejects.toThrow('boom')
  })
})

const infinite = () => ({
  text: '',
  toolCalls: [
    { toolCallId: `c${mock_state.generate_text_call_count}`, toolName: 'loop', input: {} },
  ],
  finishReason: 'tool-calls',
  usage: { inputTokens: 1, outputTokens: 1 },
})

describe('generate: tool loop', () => {
  it('runs one tool round', async () => {
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

  it('ends the loop after one turn when a terminal tool (ends_turn) succeeds', async () => {
    // Only one provider turn is queued: a second call would throw
    // 'no response queued', so a passing call_count of 1 proves the loop stopped.
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'finish', input: { v: 'x' } }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 2 },
    })
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      tools: [
        {
          name: 'finish',
          description: 'ends the run',
          input_schema: z.object({ v: z.string() }),
          execute: () => 'summary',
          ends_turn: true,
        },
      ],
    })
    expect(mock_state.generate_text_call_count).toBe(1)
    expect(result.finish_reason).toBe('stop')
    expect(result.steps).toHaveLength(1)
    expect(result.tool_calls[0]).toMatchObject({ name: 'finish', output: 'summary' })
  })

  it('surfaces a terminal-tool finish as a stop finish chunk when streaming', async () => {
    enqueue_stream([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'finish', input: { v: 'x' } },
      { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 3, outputTokens: 1 } },
    ])
    const chunks: StreamChunk[] = []
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      tools: [
        {
          name: 'finish',
          description: 'ends the run',
          input_schema: z.object({ v: z.string() }),
          execute: () => 'summary',
          ends_turn: true,
        },
      ],
      on_chunk: (c) => {
        chunks.push(c)
      },
    })
    expect(mock_state.stream_text_call_count).toBe(1)
    expect(result.finish_reason).toBe('stop')
    expect(chunks.at(-1)).toMatchObject({ kind: 'finish', finish_reason: 'stop' })
    expect(chunks.some((c) => c.kind === 'tool_result' && c.id === 'c1')).toBe(true)
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

  it('hits max_steps with the attempted-but-unexecuted marker', async () => {
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

  it('under throw policy, a tool error bubbles out', async () => {
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

function make_span_recorder(): {
  logger: TrajectoryLogger
  events: TrajectoryEvent[]
  starts: Array<{ id: string; name: string; attrs?: Record<string, unknown> | undefined }>
  ends: Array<{ id: string; attrs?: Record<string, unknown> | undefined }>
} {
  const events: TrajectoryEvent[] = []
  const starts: Array<{ id: string; name: string; attrs?: Record<string, unknown> | undefined }> =
    []
  const ends: Array<{ id: string; attrs?: Record<string, unknown> | undefined }> = []
  let n = 0
  const logger: TrajectoryLogger = {
    record: (e) => events.push(e),
    start_span: (name, attrs) => {
      n += 1
      const id = `span-${n}`
      starts.push({ id, name, attrs })
      return id
    },
    end_span: (id, attrs) => ends.push({ id, attrs }),
  }
  return { logger, events, starts, ends }
}

describe('generate: approval, schema repair, cost, and finish', () => {
  it('opens the generate span with the exact tools/schema/streaming flags', async () => {
    enqueue_stream([
      { type: 'text-delta', text: 'ok' },
      { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } },
    ])
    const { logger, starts, ends } = make_span_recorder()
    await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'hi',
      tools: [{ name: 't', description: 'd', input_schema: z.object({}), execute: () => 'x' }],
      on_chunk: () => {},
      trajectory: logger,
    })
    const gen = starts.find((s) => s.name === 'engine.generate')
    expect(gen?.attrs).toMatchObject({
      model: 'claude-opus',
      provider: 'anthropic',
      model_id: 'claude-opus',
      has_tools: true,
      has_schema: false,
      streaming: true,
    })
    const end = ends.find((e) => e.id === gen?.id)
    expect(end?.attrs).toMatchObject({
      finish_reason: 'stop',
      model_resolved: { provider: 'anthropic', model_id: 'claude-opus' },
    })
    expect(end?.attrs?.['usage']).toBeDefined()
  })

  it('opens the generate span with has_schema true when a schema is set', async () => {
    enqueue_generate_text(make_text_result('{"n": 1}'))
    const { logger, starts } = make_span_recorder()
    await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      schema: z.object({ n: z.number() }),
      trajectory: logger,
    })
    const gen = starts.find((s) => s.name === 'engine.generate')
    expect(gen?.attrs).toMatchObject({ has_schema: true })
  })

  it('opens the generate span with false flags for a plain completion', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const { logger, starts } = make_span_recorder()
    await basic_engine().generate({ model: 'claude-opus', prompt: 'hi', trajectory: logger })
    const gen = starts.find((s) => s.name === 'engine.generate')
    expect(gen?.attrs).toMatchObject({ has_tools: false, has_schema: false, streaming: false })
  })

  it('ends the generate span with the error message when the call throws', async () => {
    enqueue_generate_text(make_text_result('not json'))
    enqueue_generate_text(make_text_result('still not json'))
    const { logger, ends } = make_span_recorder()
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'x',
        schema: z.object({ n: z.number() }),
        trajectory: logger,
      }),
    ).rejects.toBeInstanceOf(schema_validation_error)
    // The catch closes the span with { error: message }; an emptied object
    // literal there would drop the error attribute.
    const errored = ends.find((e) => typeof e.attrs?.['error'] === 'string')
    expect(errored).toBeDefined()
  })

  it('appends the schema prefix to an existing leading system message', async () => {
    enqueue_generate_text(make_text_result('{"n": 1}'))
    await basic_engine().generate({
      model: 'claude-opus',
      system: 'be brief',
      prompt: 'hi',
      schema: z.object({ n: z.number() }),
    })
    const params = mock_state.last_generate_text_params as { instructions?: string }
    // The prefix is appended to the existing system run, not prepended as a new
    // system message; find-index + the append block must both fire.
    expect(params.instructions).toBe(`be brief\n\n${SHOWN_N_SCHEMA}`)
  })

  it('prepends a system message with the schema prefix when the call has none', async () => {
    enqueue_generate_text(make_text_result('{"n": 1}'))
    await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'hi',
      schema: z.object({ n: z.number() }),
    })
    const params = mock_state.last_generate_text_params as { instructions?: string }
    expect(params.instructions).toBe(SHOWN_N_SCHEMA)
  })

  it('keeps the bare request when JSON Schema cannot express the schema', async () => {
    enqueue_generate_text(make_text_result('{"when": "2026-10-20"}'))
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'hi',
      schema: z.object({ when: z.coerce.date() }),
    })
    const params = mock_state.last_generate_text_params as { instructions?: string }
    // zod refuses to emit a Date, and the call still validates the reply.
    expect(params.instructions).toBe(BARE_SCHEMA_REQUEST)
    expect(result.content.when).toBeInstanceOf(Date)
  })

  it('keeps the bare request for a vendor without Standard JSON Schema', async () => {
    enqueue_generate_text(make_text_result('{"n": 1}'))
    const validate_only = {
      '~standard': { version: 1, vendor: 'validate-only', validate: (value: unknown) => ({ value }) },
    } as unknown as ToolSchema<{ n: number }>
    const result = await basic_engine().generate({ model: 'claude-opus', prompt: 'hi', schema: validate_only })
    const params = mock_state.last_generate_text_params as { instructions?: string }
    expect(params.instructions).toBe(BARE_SCHEMA_REQUEST)
    expect(result.content).toEqual({ n: 1 })
  })

  it('rejects a negative tool_call_repair_attempts with the exact message', async () => {
    let err: unknown
    try {
      await basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        tool_call_repair_attempts: -1,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(engine_config_error)
    expect((err as engine_config_error).message).toBe('tool_call_repair_attempts must be >= 0, got -1')
  })

  it('rejects a max_tool_calls_per_step below 1 with the exact message', async () => {
    let err: unknown
    try {
      await basic_engine().generate({
        model: 'claude-opus',
        prompt: 'hi',
        max_tool_calls_per_step: 0,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(engine_config_error)
    expect((err as engine_config_error).message).toBe('max_tool_calls_per_step must be >= 1, got 0')
  })

  it('records schema-repair failures with initial then repair attempt labels', async () => {
    enqueue_generate_text(make_text_result('not json'))
    enqueue_generate_text(make_text_result('still not'))
    enqueue_generate_text(make_text_result('{"n": 3}'))
    const { logger, events } = make_span_recorder()
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      schema: z.object({ n: z.number() }),
      schema_repair_attempts: 2,
      trajectory: logger,
    })
    expect(result.content).toEqual({ n: 3 })
    const failures = events.filter((e) => e.kind === 'schema_validation_failed')
    expect(failures.map((e) => e['attempt'])).toEqual(['initial', 'repair'])
    expect(failures[0]?.['raw_text']).toBe('not json')
    expect(failures[1]?.['raw_text']).toBe('still not')
  })

  it('stops schema repair at max_steps even with repair budget remaining', async () => {
    for (let i = 0; i < 6; i += 1) enqueue_generate_text(make_text_result('nope'))
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'x',
        schema: z.object({ n: z.number() }),
        schema_repair_attempts: 5,
        max_steps: 1,
      }),
    ).rejects.toBeInstanceOf(schema_validation_error)
    // The first step reaches max_steps, so the `total_steps >= max_steps` arm of
    // the exhaustion guard throws immediately; a `>` boundary or a dropped OR arm
    // would keep repairing past the cap.
    expect(mock_state.generate_text_call_count).toBe(1)
  })

  it('omits cost when a paid provider has no pricing entry', async () => {
    enqueue_generate_text(make_text_result('ok'))
    // openrouter with an unknown model has no pricing row, so aggregate_cost
    // returns undefined and the cost key must be absent (not present-undefined).
    const engine = create_engine({ providers: { openrouter: { api_key: 'k' } } })
    const result = await engine.generate({ model: 'mystery-model', prompt: 'hi' })
    expect('cost' in result).toBe(false)
  })
})

describe('generate: cost', () => {
  it('computes cost from default pricing', async () => {
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

  it('zero-cost for ollama without pricing', async () => {
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

  it('user-overridden pricing applied', async () => {
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

  it('cost with cache hits', async () => {
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

  it('partial usage fields omit cache keys', async () => {
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
  it('dispatches chunks in order', async () => {
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

  it('aborts and wraps on_chunk failures', async () => {
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

  it('does not retry after a chunk was delivered', async () => {
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

describe('generate: streamed first chunk (ai_sdk transport)', () => {
  const T0 = 1_700_000_000_000

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stamps first_chunk_ms on the first token, not the stream-open framing', async () => {
    // The SDK opens the stream 5ms in, then prefill holds the first token
    // back another 900ms. A stamp on `start` would report 5 and leave that
    // prefill inside the decode window.
    const advance_before = [5, 0, 900, 100, 50]
    enqueue_stream_script({
      parts: [
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-delta', text: 'he' },
        { type: 'text-delta', text: 'llo' },
        {
          type: 'finish-step',
          finishReason: 'stop',
          usage: { inputTokens: 2, outputTokens: 3 },
        },
      ],
      beforePart: (index) => {
        vi.setSystemTime(Date.now() + (advance_before[index] ?? 0))
      },
    })
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'hi',
      on_chunk: () => {},
    })
    expect(result.steps[0]?.timing).toEqual({
      started_at: T0,
      duration_ms: 1055,
      first_chunk_ms: 905,
    })
  })

  it('retries a failure after the stream opens but before the first token', async () => {
    enqueue_stream([{ type: 'start' }, { type: 'start-step' }, { type: 'error', error: mk_5xx() }])
    enqueue_stream([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-delta', text: 'ok' },
      {
        type: 'finish-step',
        finishReason: 'stop',
        usage: { inputTokens: 2, outputTokens: 1 },
      },
    ])
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'hi',
      retry: {
        max_attempts: 2,
        initial_delay_ms: 0,
        max_delay_ms: 0,
        retry_on: ['provider_5xx'],
      },
      on_chunk: () => {},
    })
    expect(result.content).toBe('ok')
    expect(mock_state.stream_text_call_count).toBe(2)
  })
})

describe('generate: retry', () => {
  it('retries a 429 and succeeds on the third attempt', async () => {
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

  it('exhausts and throws rate_limit_error', async () => {
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

  it('5xx retries and surfaces provider_error after exhaustion', async () => {
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
  it('throws aborted_error synchronously on a pre-aborted signal', async () => {
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
  it('fails closed without on_tool_approval', async () => {
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

  it('tool_approval_denied feeds back under feed_back policy', async () => {
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

describe('generate: prepare_step (ai_sdk transport)', () => {
  it('reshapes the messages the SDK receives without touching the transcript', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const result = await basic_engine().generate({
      model: 'claude-opus-4-8',
      prompt: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      // Window down to the last message only for the turn actually sent.
      prepare_step: ({ messages }) => ({ messages: messages.slice(-1) }),
    })
    expect(result.content).toBe('ok')
    const params = mock_state.last_generate_text_params as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(params.messages).toHaveLength(1)
    expect(params.messages[0]).toMatchObject({ role: 'user', content: 'second' })
  })
})

// An adapter that translates effort through
// translate_effort_to_sdk_reasoning gets the level onto the SDK call's own
// `reasoning` option, and builds no provider options of its own.
describe('generate: the AI SDK reasoning option', () => {
  function reasoning_engine() {
    return create_engine({
      providers: { sdk_reasoning: {} },
      custom_providers: {
        sdk_reasoning: () => ({
          kind: 'ai_sdk',
          name: 'sdk_reasoning',
          build_model: async (model_id: string) => ({ _mock: true, model_id }),
          translate_effort: translate_effort_to_sdk_reasoning,
          normalize_usage: default_normalize_usage,
          supports: () => true,
        }),
      },
    })
  }

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'hands effort %s to generateText as reasoning, with no providerOptions',
    async (effort) => {
      enqueue_generate_text(make_text_result('ok'))
      await reasoning_engine().generate({ model: 'm', prompt: 'hi', effort })
      const params = mock_state.last_generate_text_params as Record<string, unknown>
      expect(params['reasoning']).toBe(effort)
      expect('providerOptions' in params).toBe(false)
    },
  )

  it('hands the level to streamText on a streamed call', async () => {
    enqueue_stream([
      { type: 'text-delta', text: 'ok' },
      { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ])
    await reasoning_engine().generate({ model: 'm', prompt: 'hi', effort: 'max', on_chunk: () => {} })
    const params = mock_state.last_stream_text_params as Record<string, unknown>
    expect(params['reasoning']).toBe('max')
  })

  it('leaves reasoning off the call for effort none', async () => {
    enqueue_generate_text(make_text_result('ok'))
    await reasoning_engine().generate({ model: 'm', prompt: 'hi', effort: 'none' })
    const params = mock_state.last_generate_text_params as Record<string, unknown>
    expect('reasoning' in params).toBe(false)
  })

  it("keeps a caller's provider_options beside the level", async () => {
    enqueue_generate_text(make_text_result('ok'))
    await reasoning_engine().generate({
      model: 'm',
      prompt: 'hi',
      effort: 'high',
      provider_options: { anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } },
    })
    const params = mock_state.last_generate_text_params as Record<string, unknown>
    expect(params['reasoning']).toBe('high')
    expect(params['providerOptions']).toStrictEqual({
      anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
    })
  })
})

describe('generate: duplicate tool names', () => {
  const tool = (name: string): Tool => ({
    name,
    description: `the ${name} tool`,
    input_schema: z.object({}),
    execute: () => 'ok',
  })
  const tools = ['search', 'read_file', 'search', 'list_files', 'read_file', 'read_file'].map(tool)
  const message =
    "duplicate tool names: search (2), read_file (3); give each tool its own name, or pass `name_prefix` to mcp_client for one server's tools"

  it('throws engine_config_error on native before any request', async () => {
    const { engine, requests } = make_loop_engine(['never sent'])
    const call = engine.generate({ model: 'loop', prompt: 'go', tools })
    await expect(call).rejects.toBeInstanceOf(engine_config_error)
    await expect(call).rejects.toThrow(message)
    expect(requests).toStrictEqual([])
  })

  it('throws engine_config_error on ai_sdk before the SDK is called', async () => {
    const call = basic_engine().generate({ model: 'claude-opus-4-8', prompt: 'go', tools })
    await expect(call).rejects.toBeInstanceOf(engine_config_error)
    await expect(call).rejects.toThrow(message)
    expect(mock_state.generate_text_call_count).toBe(0)
    expect(mock_state.stream_text_call_count).toBe(0)
  })

  it('throws engine_config_error on claude_cli before any subprocess starts', async () => {
    // This file's registry mock lists no claude_cli, so the real adapter is
    // registered under a custom name. A spawn of this path would fail as
    // claude_cli_error, so the config error proves the check ran first.
    const engine = create_engine({
      providers: { cli: { binary: '/nonexistent/fascicle-test/claude' } },
      custom_providers: { cli: create_claude_cli_adapter },
    })
    const call = engine.generate({ model: 'sonnet', prompt: 'go', tools })
    await expect(call).rejects.toBeInstanceOf(engine_config_error)
    await expect(call).rejects.toThrow(message)
  })
})

describe('generate: the native retry rule across the first chunk', () => {
  const NO_WAIT = {
    max_attempts: 3,
    initial_delay_ms: 0,
    max_delay_ms: 0,
    retry_on: ['network', 'timeout'] as Array<'network' | 'timeout'>,
  }
  const done: TurnResult = {
    text: 'done',
    tool_calls: [],
    finish_reason: 'stop',
    usage: { input_tokens: 1, output_tokens: 1 },
  }

  /**
   * An engine whose first attempt streams a chunk and then fails as `fail`
   * says. `streams` records whether each attempt was asked for a stream.
   */
  function failing_after_a_chunk(fail: (req: TurnRequest) => Promise<never>): {
    engine: ReturnType<typeof create_engine>
    attempts: () => number
    streams: boolean[]
  } {
    let attempts = 0
    const streams: boolean[] = []
    const engine = create_engine({
      providers: { midstream: {} },
      custom_providers: {
        midstream: () => ({
          kind: 'native',
          name: 'midstream',
          supports: () => true,
          invoke_turn: async (req) => {
            attempts += 1
            streams.push(req.stream)
            await req.dispatch_chunk?.({ kind: 'text', text: 'partial', step_index: req.step_index })
            if (attempts === 1) return fail(req)
            return done
          },
        }),
      },
    })
    return { engine, attempts: () => attempts, streams }
  }

  const reset = async (): Promise<never> => {
    throw Object.assign(new Error('connection reset'), { kind: 'network' })
  }

  it('retries a mid-stream network failure only when no consumer saw a chunk, and nothing deterministic', async () => {
    const { engine, attempts, streams } = failing_after_a_chunk(reset)
    const result = await engine.generate({ model: 'm', prompt: 'hi', retry: NO_WAIT })
    expect(result.content).toBe('done')
    expect(attempts()).toBe(2)
    expect(streams).toStrictEqual([true, true])

    const watched = failing_after_a_chunk(reset)
    const seen: StreamChunk[] = []
    const interrupted = await watched.engine
      .generate({ model: 'm', prompt: 'hi', retry: NO_WAIT, on_chunk: (c) => void seen.push(c) })
      .catch((e: unknown) => e)
    expect(interrupted).toBeInstanceOf(provider_error)
    expect(interrupted).toMatchObject({ message: 'stream interrupted: connection reset', cause_kind: 'unknown' })
    expect(watched.attempts()).toBe(1)
    expect(seen.map((c) => c.kind)).toStrictEqual(['text'])

    // A malformed frame fails the same way every time, so it never burns the budget.
    const malformed = failing_after_a_chunk(async () => {
      throw new provider_error('stream frame is not valid JSON')
    })
    const caught = await malformed.engine
      .generate({ model: 'm', prompt: 'hi', retry: NO_WAIT })
      .catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(provider_error)
    expect((caught as Error).message).toBe('stream frame is not valid JSON')
    expect(malformed.attempts()).toBe(1)
  })

  it('retries a turn timeout that fires mid-stream only when nothing consumes the chunks', async () => {
    const hang = (req: TurnRequest): Promise<never> =>
      new Promise((_resolve, reject) => {
        req.abort.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    const { engine, attempts, streams } = failing_after_a_chunk(hang)
    const result = await engine.generate({ model: 'm', prompt: 'hi', retry: NO_WAIT, turn_timeout_ms: 20 })
    expect(result.content).toBe('done')
    expect(attempts()).toBe(2)
    expect(streams).toStrictEqual([true, true])

    const watched = failing_after_a_chunk(hang)
    const caught = await watched.engine
      .generate({ model: 'm', prompt: 'hi', retry: NO_WAIT, turn_timeout_ms: 20, on_chunk: () => {} })
      .catch((e: unknown) => e)
    expect((caught as Error).message).toMatch(/^stream interrupted: /)
    expect(watched.attempts()).toBe(1)
  })
})

describe('the ai mock serves a queued generateText response to a streamed turn', () => {
  const lookup: Tool = {
    name: 'lookup',
    description: 'look a key up',
    input_schema: z.object({ key: z.string() }),
    execute: () => 'value',
  }

  /** Queue a tool-call turn and a final answer, then run the loop. */
  async function run(on_chunk: ((chunk: StreamChunk) => void) | undefined) {
    reset_mock_state()
    enqueue_generate_text({
      text: 'Looking.',
      toolCalls: [{ toolCallId: 'call_1', toolName: 'lookup', input: { key: 'a' } }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 11, outputTokens: 7 },
    })
    enqueue_generate_text_fn(async () => make_text_result('found it', { input_tokens: 20, output_tokens: 4 }))
    const result = await basic_engine().generate({
      model: 'claude-opus-4-8',
      prompt: 'look a up',
      tools: [lookup],
      ...(on_chunk !== undefined ? { on_chunk } : {}),
    })
    return {
      result,
      generate_calls: mock_state.generate_text_call_count,
      stream_calls: mock_state.stream_text_call_count,
      tools: (mock_state.last_generate_text_params as { tools?: Record<string, unknown> }).tools,
    }
  }

  it('gives the call with on_chunk the text, tool calls, usage, and finish reason the call without one gets', async () => {
    const whole = await run(undefined)
    const chunks: StreamChunk[] = []
    const streamed = await run((chunk) => {
      chunks.push(chunk)
    })

    const view = (r: typeof whole.result): unknown => ({
      content: r.content,
      finish_reason: r.finish_reason,
      usage: r.usage,
      tool_calls: r.tool_calls.map(({ id, name, input, output }) => ({ id, name, input, output })),
      steps: r.steps.map((step) => [step.text, step.finish_reason, step.usage]),
    })
    expect(view(streamed.result)).toStrictEqual(view(whole.result))
    expect(streamed.result.content).toBe('found it')
    expect(streamed.result.usage).toStrictEqual({ input_tokens: 31, output_tokens: 11 })

    // The fallback counts as the generateText calls it stands in for.
    expect([streamed.generate_calls, streamed.stream_calls]).toStrictEqual([2, 0])
    expect(Object.keys(streamed.tools ?? {})).toStrictEqual(['lookup'])
    expect(chunks.map((c) => c.kind)).toStrictEqual([
      'text',
      'tool_call_start',
      'tool_call_input_delta',
      'tool_call_end',
      'step_finish',
      'tool_result',
      'text',
      'step_finish',
      'finish',
    ])
  })

  it('carries a queued result\'s providerMetadata to the step and its content parts to the turn', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'call_1', toolName: 'lookup', input: { key: 'a' } }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 5, outputTokens: 3 },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 3 } },
      content: [
        { type: 'reasoning', text: 'think', providerMetadata: { anthropic: { signature: 'sig' } } },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', input: { key: 'a' } },
      ],
    })
    enqueue_generate_text(make_text_result('found it'))
    const result = await basic_engine().generate({
      model: 'claude-opus-4-8',
      prompt: 'look a up',
      tools: [lookup],
      on_chunk: () => {},
    })
    expect(result.steps[0]?.provider_reported).toStrictEqual({ anthropic: { cacheCreationInputTokens: 3 } })
    expect(mock_state.stream_text_call_count).toBe(0)
    // The reasoning part, signature and all, goes back with the next request.
    const sent = (mock_state.last_generate_text_params as { messages: Array<{ role: string; content: unknown }> })
      .messages
    expect(sent.find((m) => m.role === 'assistant')?.content).toMatchObject([
      { type: 'reasoning', text: 'think', providerOptions: { anthropic: { signature: 'sig' } } },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup' },
    ])
  })

  it('surfaces a queued error, or a function entry that rejects, as the stream failing', async () => {
    enqueue_generate_text(Object.assign(new Error('bad request'), { statusCode: 400 }))
    await expect(
      basic_engine().generate({ model: 'claude-opus-4-8', prompt: 'hi', on_chunk: () => {} }),
    ).rejects.toThrow('bad request')

    enqueue_generate_text_fn(async () => {
      throw new Error('rejected later')
    })
    await expect(
      basic_engine().generate({ model: 'claude-opus-4-8', prompt: 'hi', on_chunk: () => {} }),
    ).rejects.toThrow('rejected later')
  })
})

describe('generate: ai_sdk turn timing across a retry', () => {
  it("measures a retried turn's first_chunk_ms from its own attempt, with no consumer", async () => {
    const T0 = 1_700_000_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    try {
      const advance = (ms: number): void => {
        vi.setSystemTime(Date.now() + ms)
      }
      enqueue_stream_script({
        parts: [
          { type: 'text-delta', text: 'a' },
          { type: 'error', error: Object.assign(new Error('connection reset'), { kind: 'network' }) },
        ],
        beforePart: (index) => advance(index === 0 ? 100 : 300),
      })
      enqueue_stream_script({
        parts: [
          { type: 'text-delta', text: 'a' },
          { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } },
        ],
        beforePart: (index) => advance(index === 0 ? 40 : 10),
      })
      const result = await basic_engine().generate({
        model: 'claude-opus-4-8',
        prompt: 'hi',
        retry: { max_attempts: 2, initial_delay_ms: 0, max_delay_ms: 0, retry_on: ['network'] },
      })
      expect(mock_state.stream_text_call_count).toBe(2)
      // The first attempt's chunk, 400 ms before this attempt began, counts for nothing.
      expect(result.steps[0]?.timing).toEqual({ started_at: T0 + 400, duration_ms: 50, first_chunk_ms: 40 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('generate: the cache setting', () => {
  const sum: Tool = {
    name: 'sum',
    description: 'add the numbers up',
    input_schema: z.object({}),
    execute: () => 3,
  }
  type Declared = 'with_tools' | 'opt_in' | 'automatic' | undefined
  type Row = {
    readonly declared: Declared
    readonly tools: boolean
    readonly cache: 'off' | '5m' | '1h' | undefined
    readonly sent: '5m' | '1h' | undefined
  }

  /** Run one call on a double that declares `declared`, and read each request's `cache`. */
  async function sent_cache(row: Row): Promise<{ requests: TurnRequest[]; events: TrajectoryEvent[] }> {
    const { engine, requests } = make_loop_engine(
      row.tools ? [[{ name: 'sum', input: {} }], 'done'] : ['done'],
      row.declared === undefined ? {} : { prompt_cache: row.declared },
    )
    const recorder = make_recorder()
    await engine.generate({
      prompt: 'go',
      trajectory: recorder.logger,
      ...(row.tools ? { tools: [sum] } : {}),
      ...(row.cache === undefined ? {} : { cache: row.cache }),
    })
    return { requests, events: recorder.events }
  }

  it.each<Row>([
    { declared: 'with_tools', tools: true, cache: undefined, sent: '5m' },
    { declared: 'with_tools', tools: false, cache: undefined, sent: undefined },
    { declared: 'with_tools', tools: false, cache: '1h', sent: '1h' },
    { declared: 'with_tools', tools: true, cache: '1h', sent: '1h' },
    { declared: 'with_tools', tools: true, cache: 'off', sent: undefined },
    { declared: 'opt_in', tools: true, cache: undefined, sent: undefined },
    { declared: 'opt_in', tools: false, cache: '5m', sent: '5m' },
    { declared: 'opt_in', tools: true, cache: '1h', sent: '1h' },
    { declared: 'opt_in', tools: true, cache: 'off', sent: undefined },
    { declared: 'automatic', tools: true, cache: undefined, sent: undefined },
    { declared: 'automatic', tools: true, cache: '5m', sent: undefined },
    { declared: undefined, tools: true, cache: undefined, sent: undefined },
    { declared: undefined, tools: true, cache: '1h', sent: undefined },
  ])('declared $declared, tools $tools, cache $cache: every request carries $sent', async (row) => {
    const { requests } = await sent_cache(row)
    expect(requests).toHaveLength(row.tools ? 2 : 1)
    for (const req of requests) {
      if (row.sent === undefined) expect('cache' in req).toBe(false)
      else expect(req.cache).toBe(row.sent)
    }
  })

  it.each<[Declared, string]>([
    ['automatic', 'the provider caches on its own'],
    [undefined, "this adapter doesn't request prompt caching"],
  ])('declared %s: an explicit setting records option_ignored once per call, with its reason', async (declared, reason) => {
    for (const cache of ['5m', '1h'] as const) {
      const { events } = await sent_cache({ declared, tools: true, cache, sent: undefined })
      const ignored = events.filter((e) => e.kind === 'option_ignored')
      expect(ignored).toStrictEqual([
        { kind: 'option_ignored', option: 'cache', provider: 'loop', reason, ts: expect.any(Number) },
      ])
    }
  })

  it.each<Declared>(['automatic', undefined, 'with_tools', 'opt_in'])(
    'declared %s: no explicit setting, or off, records nothing',
    async (declared) => {
      for (const cache of [undefined, 'off'] as const) {
        const { events } = await sent_cache({ declared, tools: true, cache, sent: undefined })
        expect(events.filter((e) => e.kind === 'option_ignored')).toStrictEqual([])
      }
    },
  )

  it('records a declared adapter honoring an explicit setting as nothing ignored', async () => {
    const { events } = await sent_cache({ declared: 'opt_in', tools: true, cache: '5m', sent: '5m' })
    expect(events.filter((e) => e.kind === 'option_ignored')).toStrictEqual([])
  })

  it('throws engine_config_error for an unknown cache before any request', async () => {
    const { engine, requests } = make_loop_engine(['never sent'], { prompt_cache: 'with_tools' })
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const call = engine.generate({ prompt: 'go', cache: '5min' as unknown as '5m' })
    await expect(call).rejects.toBeInstanceOf(engine_config_error)
    await expect(call).rejects.toThrow(`cache must be one of 'off', '5m', '1h', got "5min"`)
    expect(requests).toStrictEqual([])
  })

  it('throws engine_config_error for an unknown cache on claude_cli before any subprocess starts', async () => {
    // As in the duplicate-name test above, a spawn of this binary would fail
    // as claude_cli_error, so the config error proves the check ran first.
    const engine = create_engine({
      providers: { cli: { binary: '/nonexistent/fascicle-test/claude' } },
      custom_providers: { cli: create_claude_cli_adapter },
    })
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const call = engine.generate({ model: 'sonnet', prompt: 'go', cache: 'on' as unknown as '5m' })
    await expect(call).rejects.toBeInstanceOf(engine_config_error)
    await expect(call).rejects.toThrow(`cache must be one of 'off', '5m', '1h', got "on"`)
  })

  it('takes an inherited key such as toString as unknown', async () => {
    const { engine } = make_loop_engine(['never sent'])
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const call = engine.generate({ prompt: 'go', cache: 'toString' as unknown as '5m' })
    await expect(call).rejects.toThrow(`cache must be one of 'off', '5m', '1h', got "toString"`)
  })
})

describe('generate: the caching each built-in adapter declares', () => {
  it.each<[string, 'with_tools' | 'opt_in' | 'automatic' | undefined, ProviderFactory, ProviderInit]>([
    ['anthropic native', 'with_tools', create_anthropic_adapter, { api_key: 'k', transport: 'native' }],
    ['anthropic ai_sdk', 'with_tools', create_anthropic_adapter, { api_key: 'k' }],
    ['openai native', 'automatic', create_openai_adapter, { api_key: 'k', transport: 'native' }],
    ['openai ai_sdk', 'automatic', create_openai_adapter, { api_key: 'k' }],
    ['google', 'automatic', create_google_adapter, { api_key: 'k' }],
    ['openrouter native', 'opt_in', create_openrouter_adapter, { api_key: 'k', transport: 'native' }],
    ['openrouter ai_sdk', undefined, create_openrouter_adapter, { api_key: 'k' }],
    ['bedrock', undefined, create_bedrock_adapter, { region: 'us-east-1', api_key: 'k' }],
    ['ollama native', undefined, create_ollama_adapter, { base_url: 'http://x', transport: 'native' }],
    ['ollama ai_sdk', undefined, create_ollama_adapter, { base_url: 'http://x' }],
    ['lmstudio native', undefined, create_lmstudio_adapter, { base_url: 'http://x', transport: 'native' }],
    ['lmstudio ai_sdk', undefined, create_lmstudio_adapter, { base_url: 'http://x' }],
  ])('%s declares %s', (_label, declared, factory, init) => {
    const adapter = factory(init)
    if (declared === undefined) expect('prompt_cache' in adapter).toBe(false)
    else expect(Reflect.get(adapter, 'prompt_cache')).toBe(declared)
  })
})
