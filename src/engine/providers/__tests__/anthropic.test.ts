import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { TrajectoryEvent } from '#core'
import {
  create_anthropic_adapter,
  normalize_anthropic_usage,
  translate_anthropic_cache,
} from '../anthropic.js'
import { create_engine } from '../../create_engine.js'
import { engine_config_error } from '../../errors.js'
import type { AiSdkProviderAdapter } from '../types.js'
import type { GenerateOptions, Tool } from '../../types.js'

// The level goes to the AI SDK's own `reasoning`
// option, which @ai-sdk/anthropic maps per model, and no provider options are built.
describe('anthropic ai_sdk effort translation', () => {
  const adapter = create_anthropic_adapter({ api_key: 'sk-test' })
  if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'hands %s to the SDK reasoning option with no provider options',
    (level) => {
      expect(adapter.translate_effort(level)).toStrictEqual({
        provider_options: {},
        effort_ignored: false,
        reasoning: level,
      })
    },
  )

  it('sends neither a reasoning level nor provider options for none', () => {
    expect(adapter.translate_effort('none')).toStrictEqual({
      provider_options: {},
      effort_ignored: false,
    })
  })
})

describe('normalize_anthropic_usage', () => {
  it('preserves flattened cache fields', () => {
    const usage = normalize_anthropic_usage({
      input_tokens: 1500,
      cached_input_tokens: 1000,
      cache_write_tokens: 200,
      output_tokens: 50,
    })
    expect(usage).toEqual({
      input_tokens: 1500,
      output_tokens: 50,
      cached_input_tokens: 1000,
      cache_write_tokens: 200,
    })
  })

  it('reads input_token_details when flattened fields are absent', () => {
    const usage = normalize_anthropic_usage({
      input_tokens: 1500,
      output_tokens: 50,
      input_token_details: { cached_tokens: 1000, cache_creation_input_tokens: 200 },
    })
    expect(usage.cached_input_tokens).toBe(1000)
    expect(usage.cache_write_tokens).toBe(200)
  })
})

describe('create_anthropic_adapter', () => {
  it('throws engine_config_error when api_key is missing', () => {
    expect(() => create_anthropic_adapter({ api_key: '' })).toThrow(engine_config_error)
  })

  it('supports reasoning, tools, schema, streaming, images', () => {
    const adapter = create_anthropic_adapter({ api_key: 'secret' })
    for (const cap of ['text', 'tools', 'schema', 'streaming', 'image_input', 'reasoning'] as const) {
      expect(adapter.supports(cap)).toBe(true)
    }
  })

  it('build_model returns a value when the @ai-sdk/anthropic peer resolves', async () => {
    const adapter = create_anthropic_adapter({ api_key: 'secret' })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    const model = await adapter.build_model('claude-opus-4-7')
    expect(model).toBeDefined()
  })
})

describe('transport dispatch', () => {
  it('defaults to the ai_sdk adapter', () => {
    expect(create_anthropic_adapter({ api_key: 'secret' }).kind).toBe('ai_sdk')
  })

  it("returns the ai_sdk adapter for transport: 'ai_sdk'", () => {
    expect(create_anthropic_adapter({ api_key: 'secret', transport: 'ai_sdk' }).kind).toBe(
      'ai_sdk',
    )
  })

  it("returns the native adapter for transport: 'native', keeping the provider name", () => {
    const adapter = create_anthropic_adapter({ api_key: 'secret', transport: 'native' })
    expect(adapter.kind).toBe('native')
    expect(adapter.name).toBe('anthropic')
  })

  it('throws engine_config_error on an unknown transport, tagged with the provider', () => {
    let err: unknown
    try {
      create_anthropic_adapter({ api_key: 'secret', transport: 'grpc' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(engine_config_error)
    expect((err as engine_config_error).message).toBe(
      `anthropic provider: transport must be 'ai_sdk' or 'native', got "grpc"`,
    )
    expect((err as engine_config_error).provider).toBe('anthropic')
  })
})

describe('translate_anthropic_cache', () => {
  it("turns '5m' and '1h' into the call-level cacheControl", () => {
    expect(translate_anthropic_cache('5m', undefined)).toStrictEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    })
    expect(translate_anthropic_cache('1h', { anthropic: { sendReasoning: true } })).toStrictEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    })
  })

  it("adds nothing for 'off'", () => {
    expect(translate_anthropic_cache('off', undefined)).toStrictEqual({})
    expect(translate_anthropic_cache('off', { openai: { cacheControl: 'x' } })).toStrictEqual({})
  })

  it("derives nothing when the caller set cacheControl under anthropic", () => {
    expect(
      translate_anthropic_cache('1h', { anthropic: { cacheControl: { type: 'ephemeral' } } }),
    ).toStrictEqual({})
    expect(
      translate_anthropic_cache('1h', {
        anthropic: { cacheControl: { type: 'ephemeral' }, cache_control: { type: 'ephemeral', ttl: '1h' } },
      }),
    ).toStrictEqual({})
  })

  it("returns a caller's cache_control as cacheControl, whatever the setting", () => {
    for (const cache of ['off', '5m', '1h'] as const) {
      expect(
        translate_anthropic_cache(cache, { anthropic: { cache_control: { type: 'ephemeral', ttl: '1h' } } }),
      ).toStrictEqual({ anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } })
    }
  })

  it('reads a non-object anthropic entry, null included, as holding neither key', () => {
    for (const anthropic of ['raw', null]) {
      expect(translate_anthropic_cache('5m', { anthropic })).toStrictEqual({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      })
    }
  })

  it("is the ai_sdk adapter's hook, beside its 'with_tools' declaration", () => {
    const adapter = create_anthropic_adapter({ api_key: 'sk-test' })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    expect(adapter.prompt_cache).toBe('with_tools')
    expect(adapter.translate_cache).toBe(translate_anthropic_cache)
  })
})

// The real `ai` and `@ai-sdk/anthropic` run here, and only fetch is stubbed,
// so these tests read the request body that the package builds from the
// call-level options.
describe('prompt caching on the ai_sdk transport, on the wire', () => {
  const tool: Tool = {
    name: 'sum',
    description: 'add the numbers up',
    input_schema: z.object({}),
    execute: () => 3,
  }

  const SSE = [
    {
      type: 'message_start',
      message: {
        id: 'msg_cache',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Send one call through an ai_sdk anthropic engine and parse the body the package sent. */
  async function wire_body(
    call: Partial<GenerateOptions>,
    custom?: (adapter: AiSdkProviderAdapter) => AiSdkProviderAdapter,
  ): Promise<{ body: Record<string, unknown>; events: TrajectoryEvent[] }> {
    const mock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    )
    vi.stubGlobal('fetch', mock)
    const events: TrajectoryEvent[] = []
    const engine =
      custom === undefined
        ? create_engine({ providers: { anthropic: { api_key: 'sk-test' } } })
        : create_engine({
            providers: { claude_custom: { api_key: 'sk-test' } },
            custom_providers: {
              claude_custom: (init) => {
                const adapter = create_anthropic_adapter(init)
                if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
                return custom(adapter)
              },
            },
          })
    await engine.generate({
      model: 'claude-sonnet-5-5',
      prompt: 'hi',
      trajectory: { record: (e) => events.push(e), start_span: () => 'span', end_span: () => {} },
      ...call,
    })
    const init = (mock.mock.calls[0] as [string, RequestInit])[1]
    return { body: JSON.parse(init.body as string) as Record<string, unknown>, events }
  }

  it('sends a top-level cache_control by default on a call with tools', async () => {
    const { body } = await wire_body({ tools: [tool] })
    expect(body['cache_control']).toStrictEqual({ type: 'ephemeral' })
  })

  it("sends none without tools, or with cache 'off', and a one-hour one for '1h'", async () => {
    expect((await wire_body({})).body).not.toHaveProperty('cache_control')
    expect((await wire_body({ tools: [tool], cache: 'off' })).body).not.toHaveProperty('cache_control')
    expect((await wire_body({ cache: '1h' })).body['cache_control']).toStrictEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  it('derives nothing beside a cacheControl that the caller set', async () => {
    const { body } = await wire_body({
      tools: [tool],
      cache: '1h',
      provider_options: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } },
    })
    expect(body['cache_control']).toStrictEqual({ type: 'ephemeral', ttl: '5m' })
  })

  it("sends a caller's cache_control under anthropic as the top-level cache_control", async () => {
    const { body } = await wire_body({
      cache: 'off',
      provider_options: { anthropic: { cache_control: { type: 'ephemeral', ttl: '1h' } } },
    })
    expect(body['cache_control']).toStrictEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('keeps an automatic declaration that has no translate_cache, so its reason says so', async () => {
    const automatic = (adapter: AiSdkProviderAdapter): AiSdkProviderAdapter => {
      const { translate_cache: _hook, ...rest } = adapter
      return { ...rest, prompt_cache: 'automatic' }
    }
    const asked = await wire_body({ tools: [tool], cache: '5m' }, automatic)
    expect(asked.body).not.toHaveProperty('cache_control')
    expect(asked.events.filter((e) => e.kind === 'option_ignored')).toStrictEqual([
      {
        kind: 'option_ignored',
        option: 'cache',
        provider: 'anthropic',
        reason: 'the provider caches on its own',
        ts: expect.any(Number),
      },
    ])
  })

  it('resolves a with_tools declaration that has no translate_cache as undeclared', async () => {
    const without_hook = (adapter: AiSdkProviderAdapter): AiSdkProviderAdapter => {
      const { translate_cache: _hook, ...rest } = adapter
      return rest
    }
    const by_default = await wire_body({ tools: [tool] }, without_hook)
    expect(by_default.body).not.toHaveProperty('cache_control')
    const asked = await wire_body({ tools: [tool], cache: '5m' }, without_hook)
    expect(asked.body).not.toHaveProperty('cache_control')
    expect(asked.events.filter((e) => e.kind === 'option_ignored')).toStrictEqual([
      {
        kind: 'option_ignored',
        option: 'cache',
        provider: 'anthropic',
        reason: "this adapter doesn't request prompt caching",
        ts: expect.any(Number),
      },
    ])
  })
})
