/**
 * Native Anthropic adapter: request mapping, the non-stream
 * and SSE-streamed invoke_turn against golden Messages-API fixtures, and
 * error classification. Streamed results are asserted equal to the
 * non-streamed parse of the same fixture. No live network; fetch is
 * stubbed per test.
 */

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AssistantContentPart, Message, StreamChunk, Tool, TurnRequest } from '../../types.js'
import {
  build_messages_body,
  create_anthropic_native_adapter,
  map_anthropic_stop_reason,
  map_anthropic_usage,
  parse_messages_response,
  read_one_hour_writes,
  to_anthropic_messages,
} from '../anthropic_native.js'
import { classify_provider_error } from '../../generate.js'
import { create_engine } from '../../create_engine.js'
import {
  engine_config_error,
  provider_auth_error,
  provider_capability_error,
  provider_error,
} from '../../errors.js'
import { web_search_json, web_search_sse_response } from './fixtures/anthropic_web_search.js'

const weather_tool: Tool = {
  name: 'get_weather',
  description: 'Look up current weather for a city',
  input_schema: z.object({ city: z.string() }),
  execute: () => 'sunny',
}

function make_req(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    step_index: 0,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    abort: new AbortController().signal,
    stream: false,
    model_id: 'claude-sonnet-5',
    effort: 'none',
    ...overrides,
  }
}

function capture(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (e: unknown) {
    return e
  }
}

function stub_fetch(result: Response | Error): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    if (result instanceof Response) return result
    throw result
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function json_response(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const TEXT_FIXTURE = {
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'Hello there' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 6 },
}

const TOOL_CALL_FIXTURE = {
  id: 'msg_02',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [
    { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 30, output_tokens: 18 },
}

const MIXED_FIXTURE = {
  id: 'msg_03',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [
    { type: 'thinking', thinking: 'need the forecast first', signature: 'sig_abc' },
    { type: 'text', text: 'Checking the weather. ' },
    { type: 'tool_use', id: 'toolu_02', name: 'get_weather', input: { city: 'Kingston' } },
    { type: 'text', text: 'One moment.' },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 40,
    output_tokens: 25,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 10,
  },
}

describe('to_anthropic_messages', () => {
  it('hoists leading system messages and maps user text', () => {
    const messages: Message[] = [
      { role: 'system', content: 'be terse' },
      { role: 'system', content: 'answer in French' },
      { role: 'user', content: 'hi' },
    ]
    expect(to_anthropic_messages(messages)).toEqual({
      system: 'be terse\n\nanswer in French',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
  })

  it('drops a whitespace-only user string, hoisting no system and pushing no message', () => {
    expect(to_anthropic_messages([{ role: 'user', content: '   ' }])).toEqual({
      system: undefined,
      messages: [],
    })
  })

  it('maps user content parts to text blocks, dropping the whitespace-only ones', () => {
    expect(
      to_anthropic_messages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: '   ' },
            { type: 'text', text: 'second' },
          ],
        },
      ]),
    ).toEqual({
      system: undefined,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      ],
    })
  })

  it('throws provider_capability_error with exact provider/capability/detail on a mid-conversation system message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'now be verbose' },
    ]
    const err = capture(() => to_anthropic_messages(messages))
    expect(err).toBeInstanceOf(provider_capability_error)
    expect((err as provider_capability_error).provider).toBe('anthropic')
    expect((err as provider_capability_error).capability).toBe(
      'mid_conversation_system_messages',
    )
    expect((err as Error).message).toBe(
      "provider 'anthropic' does not support 'mid_conversation_system_messages': the Messages API accepts system text only before the first user/assistant turn",
    )
  })

  it('maps assistant tool_call parts to tool_use blocks and drops empty text', () => {
    const messages: Message[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'tool_call', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
        ],
      },
    ]
    expect(to_anthropic_messages(messages).messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
      ],
    })
  })

  it('merges consecutive tool results into one user message of tool_result blocks', () => {
    const messages: Message[] = [
      { role: 'user', content: 'compare two cities' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
          { type: 'tool_call', id: 'toolu_02', name: 'get_weather', input: { city: 'Kingston' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_01', name: 'get_weather', content: 'sunny' },
      { role: 'tool', tool_call_id: 'toolu_02', name: 'get_weather', content: 'rain' },
    ]
    const mapped = to_anthropic_messages(messages).messages
    expect(mapped).toHaveLength(3)
    expect(mapped[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'sunny' },
        { type: 'tool_result', tool_use_id: 'toolu_02', content: 'rain' },
      ],
    })
  })

  it('sends is_error: true on a failed call\'s tool_result alone', () => {
    const messages: Message[] = [
      { role: 'user', content: 'compare two cities' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
          { type: 'tool_call', id: 'toolu_02', name: 'get_weather', input: { city: 7 } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_01', name: 'get_weather', content: 'sunny' },
      {
        role: 'tool',
        tool_call_id: 'toolu_02',
        name: 'get_weather',
        content: '{"error":"invalid tool input: city: expected string"}',
        is_error: true,
      },
    ]
    expect(to_anthropic_messages(messages).messages[2]).toStrictEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'sunny' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_02',
          content: '{"error":"invalid tool input: city: expected string"}',
          is_error: true,
        },
      ],
    })
  })

  it('merges a user message following tool results into the same turn', () => {
    const messages: Message[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_01', name: 'get_weather', content: 'sunny' },
      { role: 'user', content: 'and tomorrow?' },
    ]
    const mapped = to_anthropic_messages(messages).messages
    expect(mapped[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'sunny' },
        { type: 'text', text: 'and tomorrow?' },
      ],
    })
  })

  it('maps an assistant string to a text block and drops a whitespace-only assistant string', () => {
    expect(
      to_anthropic_messages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'sure thing' },
      ]).messages[1],
    ).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'sure thing' }] })

    expect(
      to_anthropic_messages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '   ' },
      ]).messages,
    ).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('maps assistant text parts, dropping whitespace-only ones, and maps tool_call parts', () => {
    expect(
      to_anthropic_messages([
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'text', text: '   ' },
            { type: 'tool_call', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
          ],
        },
      ]).messages[1],
    ).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check' },
        { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
      ],
    })
  })

  it('sends its own reasoning parts back as the blocks they came from, in part order', () => {
    expect(
      to_anthropic_messages([
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'plan', provider_options: { anthropic: { signature: 'sig_1' } } },
            { type: 'text', text: 'Let me check' },
            { type: 'reasoning', text: '', provider_options: { anthropic: { redactedData: 'opaque' } } },
            { type: 'reasoning', text: '', provider_options: { anthropic: { signature: 'sig_2' } } },
            { type: 'tool_call', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
          ],
        },
      ]).messages[1],
    ).toStrictEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig_1' },
        { type: 'text', text: 'Let me check' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'thinking', thinking: '', signature: 'sig_2' },
        { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
      ],
    })
  })

  // Another vendor's signature, or thinking with none,
  // would be refused.
  it('leaves behind reasoning keyed for another provider, with no data, or with non-string data', () => {
    expect(
      to_anthropic_messages([
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'other', provider_options: { openrouter: { detail: {} } } },
            { type: 'text', text: 'Let me check' },
            { type: 'reasoning', text: 'bare' },
            { type: 'reasoning', text: 'odd', provider_options: { anthropic: { signature: 7 } } },
            { type: 'reasoning', text: '', provider_options: { anthropic: { redactedData: null } } },
            { type: 'reasoning', text: 'empty', provider_options: { anthropic: {} } },
            { type: 'tool_call', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
          ],
        },
      ]).messages[1],
    ).toStrictEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check' },
        { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
      ],
    })
  })

  it('throws provider_capability_error with exact provider/capability/detail on image parts', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'image', image: 'aGk=', media_type: 'image/png' }],
      },
    ]
    const err = capture(() => to_anthropic_messages(messages))
    expect(err).toBeInstanceOf(provider_capability_error)
    expect((err as provider_capability_error).provider).toBe('anthropic')
    expect((err as provider_capability_error).capability).toBe('image_input')
    expect((err as Error).message).toBe(
      "provider 'anthropic' does not support 'image_input': image parts are not mapped on the native transport; use transport: 'ai_sdk'",
    )
  })
})

describe('build_messages_body', () => {
  it('builds the default body with sampling params and required max_tokens', () => {
    const body = build_messages_body(
      make_req({ system: 'be terse', temperature: 0.2, top_p: 0.9 }),
    )
    expect(body).toEqual({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 4096,
      system: 'be terse',
      temperature: 0.2,
      top_p: 0.9,
    })
  })

  it.each([
    ['low', 5120],
    ['medium', 9096],
    ['high', 24096],
    ['xhigh', 36096],
    ['max', 68096],
  ] as const)(
    'maps effort %s to adaptive thinking and output_config, max_tokens %i, and drops sampling params',
    (effort, max_tokens) => {
      const body = build_messages_body(make_req({ effort, temperature: 0.2, top_p: 0.9 }))
      expect(body['thinking']).toStrictEqual({ type: 'adaptive', display: 'summarized' })
      expect(body['output_config']).toStrictEqual({ effort })
      expect(body['max_tokens']).toBe(max_tokens)
      expect(body).not.toHaveProperty('temperature')
      expect(body).not.toHaveProperty('top_p')
    },
  )

  it('sends neither thinking nor output_config for effort none', () => {
    const body = build_messages_body(make_req({ effort: 'none' }))
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('output_config')
    expect(body['max_tokens']).toBe(4096)
  })

  // A model older than 4.6 refuses adaptive, so its
  // caller sets effort none and passes the budget through.
  it('lets a passthrough thinking budget stand alone under effort none', () => {
    const body = build_messages_body(
      make_req({
        effort: 'none',
        provider_options: { anthropic: { thinking: { type: 'enabled', budget_tokens: 2048 } } },
      }),
    )
    expect(body['thinking']).toStrictEqual({ type: 'enabled', budget_tokens: 2048 })
    expect(body).not.toHaveProperty('output_config')
  })

  it('lets a passthrough thinking beat the effort-derived one, keeping output_config', () => {
    const body = build_messages_body(
      make_req({
        effort: 'high',
        provider_options: { anthropic: { thinking: { type: 'adaptive' } } },
      }),
    )
    expect(body['thinking']).toStrictEqual({ type: 'adaptive' })
    expect(body['output_config']).toStrictEqual({ effort: 'high' })
  })

  it('passes an explicit max_tokens through verbatim, even under thinking', () => {
    const body = build_messages_body(make_req({ effort: 'medium', max_tokens: 1000 }))
    expect(body['max_tokens']).toBe(1000)
  })

  it('shallow-merges provider_options.anthropic last, beating every derived field', () => {
    const body = build_messages_body(
      make_req({
        effort: 'medium',
        provider_options: {
          anthropic: { max_tokens: 512, thinking: { type: 'disabled' }, top_k: 40 },
        },
      }),
    )
    expect(body['max_tokens']).toBe(512)
    expect(body['thinking']).toEqual({ type: 'disabled' })
    expect(body['top_k']).toBe(40)
  })

  it('ignores provider_options keyed to other providers', () => {
    const body = build_messages_body(
      make_req({ provider_options: { openai: { top_k: 40 } } }),
    )
    expect(body).not.toHaveProperty('top_k')
  })

  it('maps tools to Messages-API shape via to_json_schema', () => {
    const body = build_messages_body(make_req({ tools: [weather_tool] }))
    const tools = body['tools'] as Array<Record<string, unknown>>
    expect(tools).toHaveLength(1)
    expect(tools[0]?.['name']).toBe('get_weather')
    expect(tools[0]?.['description']).toBe('Look up current weather for a city')
    expect(tools[0]?.['input_schema']).toMatchObject({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    })
  })

  // Tool payloads stay byte-identical whichever schema emitter builds them.
  // Serialized rather than structural, so key order is pinned too: these are the exact bytes the Messages API receives,
  // and the emission moved from `z.toJSONSchema` to the neutral `#schema`
  // zone underneath them. `$schema` is deliberately present, since only
  // `claude --json-schema` rejects it. `weather_tool` carries no defaulted
  // field, so the later move to a composed input-direction emission left
  // these bytes untouched as well; `#schema`'s own suite covers the shapes
  // that emission does change.
  it('emits byte-identical tool JSON Schema, $schema key included', () => {
    const body = build_messages_body(make_req({ tools: [weather_tool] }))
    const tools = body['tools'] as Array<Record<string, unknown>>
    expect(JSON.stringify(tools[0]?.['input_schema'])).toBe(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema",' +
        '"type":"object","properties":{"city":{"type":"string"}},' +
        '"required":["city"],"additionalProperties":false}',
    )
  })

  // Neutral-vendor emission is proved for real against ArkType in
  // `src/engine/__tests__/vendor_neutrality.test.ts`, not stubbed here.

  it('omits the system key when neither req.system nor a hoisted system is present', () => {
    expect(build_messages_body(make_req())).not.toHaveProperty('system')
  })

  it('filters out an empty-string req.system, leaving no system key', () => {
    expect(build_messages_body(make_req({ system: '' }))).not.toHaveProperty('system')
  })

  it('joins req.system ahead of a hoisted system message with a blank line', () => {
    const body = build_messages_body(
      make_req({
        system: 'from request',
        messages: [
          { role: 'system', content: 'from message' },
          { role: 'user', content: 'hi' },
        ],
      }),
    )
    expect(body['system']).toBe('from request\n\nfrom message')
  })

  it('applies only temperature when top_p is unset and effort is none', () => {
    const body = build_messages_body(make_req({ temperature: 0.5 }))
    expect(body['temperature']).toBe(0.5)
    expect(body).not.toHaveProperty('top_p')
  })

  it('applies only top_p when temperature is unset and effort is none', () => {
    const body = build_messages_body(make_req({ top_p: 0.8 }))
    expect(body['top_p']).toBe(0.8)
    expect(body).not.toHaveProperty('temperature')
  })

  it('sets a top-level five-minute cache_control for cache 5m', () => {
    const body = build_messages_body(make_req({ cache: '5m' }))
    expect(body['cache_control']).toStrictEqual({ type: 'ephemeral' })
  })

  it("sets a one-hour cache_control for cache 1h", () => {
    const body = build_messages_body(make_req({ cache: '1h' }))
    expect(body['cache_control']).toStrictEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('sets no cache_control when the request carries no cache', () => {
    expect(build_messages_body(make_req())).not.toHaveProperty('cache_control')
  })

  it("lets a caller's own cache_control beat the derived one", () => {
    const body = build_messages_body(
      make_req({
        cache: '1h',
        provider_options: { anthropic: { cache_control: { type: 'ephemeral', ttl: '5m' } } },
      }),
    )
    expect(body['cache_control']).toStrictEqual({ type: 'ephemeral', ttl: '5m' })
  })
})

describe('prompt caching through the engine on the native transport', () => {
  const tool: Tool = { ...weather_tool, execute: () => 'sunny' }

  /** Send one call through a native anthropic engine and parse the body it sent. */
  async function sent_body(
    call: { tools?: Tool[]; cache?: 'off' | '5m' | '1h'; provider_options?: Record<string, unknown> },
    defaults: { cache?: 'off' | '5m' | '1h' } = {},
  ): Promise<Record<string, unknown>> {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const engine = create_engine({
      providers: { anthropic: { api_key: 'k', transport: 'native' } },
      defaults,
    })
    await engine.generate({ model: 'claude-sonnet-5', prompt: 'hi', ...call })
    const init = (mock.mock.calls[0] as [string, RequestInit])[1]
    return JSON.parse(init.body as string) as Record<string, unknown>
  }

  it('caches for five minutes by default on a call with tools', async () => {
    const body = await sent_body({ tools: [tool] })
    expect(body['cache_control']).toStrictEqual({ type: 'ephemeral' })
  })

  it('sends no cache_control by default on a call without tools', async () => {
    expect(await sent_body({})).not.toHaveProperty('cache_control')
  })

  it("sends a one-hour cache_control for cache '1h', with tools or without", async () => {
    expect((await sent_body({ cache: '1h' }))['cache_control']).toStrictEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect((await sent_body({ tools: [tool], cache: '1h' }))['cache_control']).toStrictEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  it("sends no cache_control for cache 'off' on a call with tools", async () => {
    expect(await sent_body({ tools: [tool], cache: 'off' })).not.toHaveProperty('cache_control')
  })

  it("lets a caller's own cache_control win on a call with tools", async () => {
    const body = await sent_body({
      tools: [tool],
      provider_options: { anthropic: { cache_control: { type: 'ephemeral', ttl: '1h' } } },
    })
    expect(body['cache_control']).toStrictEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it("takes the engine's default cache, and a call's own setting over it", async () => {
    expect((await sent_body({}, { cache: '1h' }))['cache_control']).toStrictEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(await sent_body({ tools: [tool], cache: 'off' }, { cache: '1h' })).not.toHaveProperty(
      'cache_control',
    )
    expect(await sent_body({ tools: [tool] }, { cache: 'off' })).not.toHaveProperty('cache_control')
  })
})

describe('map_anthropic_stop_reason', () => {
  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['pause_turn', 'stop'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['refusal', 'content_filter'],
    ['something_new', 'stop'],
    [undefined, 'stop'],
  ])('maps %s to %s', (raw, expected) => {
    expect(map_anthropic_stop_reason(raw)).toBe(expected)
  })
})

describe('map_anthropic_usage', () => {
  it('copies plain input/output tokens with no cache keys', () => {
    // toStrictEqual, not toEqual: toEqual ignores `key: undefined`, so it would
    // not catch a mutant that always writes cached_input_tokens/cache_write_tokens
    // even when the source cache field is absent.
    expect(map_anthropic_usage({ input_tokens: 100, output_tokens: 20 })).toStrictEqual({
      input_tokens: 100,
      output_tokens: 20,
    })
  })

  it('folds exclusive cache reads/writes into the inclusive input total', () => {
    // The API reports 10 fresh input tokens beside the cache fields;
    // compute_cost expects input_tokens to be the inclusive superset.
    expect(
      map_anthropic_usage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 25,
      }),
    ).toStrictEqual({
      input_tokens: 125,
      output_tokens: 5,
      cached_input_tokens: 90,
      cache_write_tokens: 25,
    })
  })

  it('returns zero totals for a null usage object', () => {
    // null hits the `raw === null` operand specifically; the undefined case below
    // only exercises the `typeof raw !== 'object'` half of the guard.
    expect(map_anthropic_usage(null)).toStrictEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('returns zero totals for a missing usage object', () => {
    expect(map_anthropic_usage(undefined)).toStrictEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('reads the one-hour part of the writes from the cache_creation split', () => {
    expect(
      map_anthropic_usage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      }),
    ).toStrictEqual({
      input_tokens: 310,
      output_tokens: 5,
      cached_input_tokens: 0,
      cache_write_tokens: 300,
      cache_write_1h_tokens: 200,
    })
  })

  it('leaves the one-hour field out when the split is absent or unreadable', () => {
    expect(map_anthropic_usage({ input_tokens: 1, output_tokens: 1, cache_creation: null })).toStrictEqual({
      input_tokens: 1,
      output_tokens: 1,
    })
    expect(read_one_hour_writes(undefined)).toBeUndefined()
    expect(read_one_hour_writes('split')).toBeUndefined()
    expect(read_one_hour_writes({ ephemeral_5m_input_tokens: 4 })).toBeUndefined()
    expect(read_one_hour_writes({ ephemeral_1h_input_tokens: '4' })).toBeUndefined()
    expect(read_one_hour_writes({ ephemeral_1h_input_tokens: 0 })).toBe(0)
  })

  it('ignores non-numeric usage fields', () => {
    // A non-number read resolves to undefined, not the raw value: the string is
    // dropped from the input sum and no cache key is emitted for it.
    expect(
      map_anthropic_usage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 'lots',
        cache_creation_input_tokens: null,
      }),
    ).toStrictEqual({ input_tokens: 10, output_tokens: 5 })
  })
})

describe('parse_messages_response', () => {
  it('parses a text response', () => {
    expect(parse_messages_response(TEXT_FIXTURE)).toStrictEqual({
      text: 'Hello there',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 12, output_tokens: 6 },
    })
  })

  it('parses a tool-call response', () => {
    expect(parse_messages_response(TOOL_CALL_FIXTURE)).toStrictEqual({
      text: '',
      tool_calls: [{ id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 30, output_tokens: 18 },
    })
  })

  it('parses a mixed response, joining text and keeping every block as a part in order', () => {
    expect(parse_messages_response(MIXED_FIXTURE)).toStrictEqual({
      text: 'Checking the weather. One moment.',
      tool_calls: [{ id: 'toolu_02', name: 'get_weather', input: { city: 'Kingston' } }],
      finish_reason: 'tool_calls',
      usage: {
        input_tokens: 150,
        output_tokens: 25,
        cached_input_tokens: 100,
        cache_write_tokens: 10,
      },
      content: [
        {
          type: 'reasoning',
          text: 'need the forecast first',
          provider_options: { anthropic: { signature: 'sig_abc' } },
        },
        { type: 'text', text: 'Checking the weather. ' },
        { type: 'tool_call', id: 'toolu_02', name: 'get_weather', input: { city: 'Kingston' } },
        { type: 'text', text: 'One moment.' },
      ],
    })
  })

  it('reads redacted and empty thinking blocks, keeps a block missing its data as a bare part, and keeps an unknown block opaque', () => {
    const result = parse_messages_response({
      ...TOOL_CALL_FIXTURE,
      content: [
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'thinking', thinking: '', signature: 'sig_empty' },
        { type: 'thinking', signature: 'sig_no_text' },
        { type: 'thinking', thinking: 'unsigned' },
        { type: 'redacted_thinking' },
        { type: 'server_tool_use', id: 'srv_1' },
        ...TOOL_CALL_FIXTURE.content,
      ],
    })
    expect(result.content).toStrictEqual([
      { type: 'reasoning', text: '', provider_options: { anthropic: { redactedData: 'opaque' } } },
      { type: 'reasoning', text: '', provider_options: { anthropic: { signature: 'sig_empty' } } },
      { type: 'reasoning', text: '', provider_options: { anthropic: { signature: 'sig_no_text' } } },
      { type: 'reasoning', text: 'unsigned' },
      { type: 'reasoning', text: '' },
      { type: 'opaque', provider_options: { anthropic: { block: { type: 'server_tool_use', id: 'srv_1' } } } },
      { type: 'tool_call', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
    ])
    expect(result.text).toBe('')
  })

  // A turn with no thinking stays exactly as it was.
  it('leaves content out of a turn with no thinking block', () => {
    expect('content' in parse_messages_response(TEXT_FIXTURE)).toBe(false)
    expect('content' in parse_messages_response(TOOL_CALL_FIXTURE)).toBe(false)
  })

  it('treats non-array content as an empty result', () => {
    // Array.isArray guards the loop; a non-array content (here a number) yields an
    // empty text/tool_calls result rather than iterating a non-iterable.
    expect(
      parse_messages_response({
        content: 42,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ).toStrictEqual({
      text: '',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 1, output_tokens: 2 },
    })
  })

  it('skips null and non-object content blocks, keeping the valid one', () => {
    // The block guard skips both a null entry (the `block === null` operand) and a
    // primitive entry (the `typeof block !== 'object'` operand); the valid text
    // block after them is still collected.
    expect(
      parse_messages_response({
        content: [null, 'stray', { type: 'text', text: 'kept' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ).toStrictEqual({
      text: 'kept',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 1, output_tokens: 2 },
    })
  })

  it('ignores a text block whose text field is not a string', () => {
    expect(
      parse_messages_response({
        content: [{ type: 'text', text: 42 }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ).toStrictEqual({
      text: '',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 1, output_tokens: 2 },
    })
  })

  it('throws provider_error with its exact message on a malformed tool_use id', () => {
    const payload = {
      ...TOOL_CALL_FIXTURE,
      content: [{ type: 'tool_use', id: 42, name: 'get_weather', input: {} }],
    }
    expect(() => parse_messages_response(payload)).toThrow(provider_error)
    expect(() => parse_messages_response(payload)).toThrow(
      'anthropic native: malformed tool_use block in response content',
    )
  })

  it('throws provider_error when a tool_use name is not a string', () => {
    // The `|| typeof name !== 'string'` half of the guard: a valid string id
    // alongside a non-string name must still throw.
    const payload = {
      content: [{ type: 'tool_use', id: 'toolu_x', name: 99, input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    expect(() => parse_messages_response(payload)).toThrow(provider_error)
  })

  it('throws provider_error with its exact message on a null payload', () => {
    // null exercises the `payload === null` operand specifically.
    expect(() => parse_messages_response(null)).toThrow(provider_error)
    expect(() => parse_messages_response(null)).toThrow(
      'anthropic native: response payload is not a JSON object',
    )
  })

  it('throws provider_error on a non-object payload', () => {
    expect(() => parse_messages_response('nope')).toThrow(provider_error)
  })
})

describe('create_anthropic_native_adapter', () => {
  it('throws engine_config_error when api_key is missing', () => {
    expect(() => create_anthropic_native_adapter({ api_key: '' })).toThrow(engine_config_error)
  })

  it('claims text, tools, schema, streaming, and reasoning; not structured_output or image_input', () => {
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    expect(adapter.kind).toBe('native')
    expect(adapter.name).toBe('anthropic')
    for (const cap of ['text', 'tools', 'schema', 'streaming', 'reasoning'] as const) {
      expect(adapter.supports(cap)).toBe(true)
    }
    for (const cap of ['structured_output', 'image_input'] as const) {
      expect(adapter.supports(cap)).toBe(false)
    }
  })

  it('POSTs the mapped body with auth and version headers to the default URL', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const result = await adapter.invoke_turn(make_req({ system: 'be terse' }))

    expect(mock).toHaveBeenCalledTimes(1)
    const call = mock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('https://api.anthropic.com/v1/messages')
    expect(call[1].method).toBe('POST')
    const headers = call[1].headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(call[1].body as string)).toEqual({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 4096,
      system: 'be terse',
    })
    expect(result.text).toBe('Hello there')
  })

  it('puts provider_options.anthropic keys on the non-stream wire body', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    await adapter.invoke_turn(
      make_req({ provider_options: { anthropic: { max_tokens: 512, top_k: 40 } } }),
    )
    const call = mock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>
    expect(body['max_tokens']).toBe(512)
    expect(body['top_k']).toBe(40)
  })

  it('respects a base_url override, trimming trailing slashes', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_anthropic_native_adapter({
      api_key: 'sk-test',
      base_url: 'https://proxy.local/v1/',
    })
    await adapter.invoke_turn(make_req())
    const call = mock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('https://proxy.local/v1/messages')
  })

  it('returns the parsed TurnResult for a tool-call fixture end to end', async () => {
    stub_fetch(json_response(TOOL_CALL_FIXTURE))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const result = await adapter.invoke_turn(make_req({ tools: [weather_tool] }))
    expect(result).toEqual({
      text: '',
      tool_calls: [{ id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 30, output_tokens: 18 },
    })
  })

  it('throws provider_auth_error on 401 with the API error message', async () => {
    stub_fetch(
      json_response(
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        401,
      ),
    )
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-bad' })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_auth_error)
    expect((err as provider_auth_error).provider).toBe('anthropic')
    expect((err as Error).message).toBe(
      'anthropic authentication failed (401): invalid x-api-key',
    )
  })

  it('throws a 429 shape the shared classifier maps to rate_limit with retry_after_ms', async () => {
    stub_fetch(
      json_response(
        { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
        429,
        { 'retry-after': '2' },
      ),
    )
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    const classified = classify_provider_error(err) as Record<string, unknown>
    expect(classified['kind']).toBe('rate_limit')
    expect(classified['status']).toBe(429)
    expect(classified['retry_after_ms']).toBe(2000)
    expect(classified['message']).toBe('anthropic API error 429: Rate limited')
  })

  it('throws a 5xx shape the shared classifier maps to provider_5xx', async () => {
    stub_fetch(
      json_response({ type: 'error', error: { type: 'api_error', message: 'Overloaded' } }, 529),
    )
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    const classified = classify_provider_error(err) as Record<string, unknown>
    expect(classified['kind']).toBe('provider_5xx')
    expect(classified['status']).toBe(529)
    expect(classified['message']).toBe('anthropic API error 529: Overloaded')
  })

  it('throws a permanent provider_error on other 4xx, untouched by classification', async () => {
    stub_fetch(
      json_response(
        { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large' } },
        400,
      ),
    )
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).status).toBe(400)
    expect((err as Error).message).toBe('anthropic API error 400: max_tokens too large')
    expect(classify_provider_error(err)).toBe(err)
  })

  it('wraps transport failures as kind network for the shared classifier', async () => {
    stub_fetch(new TypeError('fetch failed'))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(Reflect.get(err as object, 'kind')).toBe('network')
    expect((err as Error).message).toBe('anthropic native: network failure: fetch failed')
    expect(classify_provider_error(err)).toBe(err)
  })

  it('rethrows the fetch abort error untouched when the signal aborted', async () => {
    const abort_err = new DOMException('This operation was aborted', 'AbortError')
    stub_fetch(abort_err)
    const controller = new AbortController()
    controller.abort()
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    await expect(
      adapter.invoke_turn(make_req({ abort: controller.signal })),
    ).rejects.toBe(abort_err)
  })
})

function sse_payload(events: ReadonlyArray<Record<string, unknown>>): string {
  return events
    .map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('')
}

/**
 * Recorded-stream Response: the SSE payload is enqueued in small byte chunks
 * so every test also exercises reassembly across arbitrary boundaries,
 * including splits inside multi-byte UTF-8 sequences. `tail` is raw SSE text
 * sent after the events, for a server's own trailer.
 */
function stream_response(
  events: ReadonlyArray<Record<string, unknown>>,
  chunk_size = 9,
  tail = '',
): Response {
  return chunked_sse_response(sse_payload(events) + tail, chunk_size)
}

function chunked_sse_response(payload: string, chunk_size: number): Response {
  const bytes = new TextEncoder().encode(payload)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk_size) {
        controller.enqueue(bytes.slice(i, i + chunk_size))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function chunk_collector(): {
  chunks: StreamChunk[]
  dispatch_chunk: (chunk: StreamChunk) => Promise<void>
} {
  const chunks: StreamChunk[] = []
  return {
    chunks,
    dispatch_chunk: async (chunk: StreamChunk): Promise<void> => {
      chunks.push(chunk)
    },
  }
}

/**
 * Raw-frame variant of stream_response: each frame is emitted verbatim as the
 * `data:` payload of one SSE event, so a test can feed handle_event a literal
 * `null`, a non-JSON body, or any shape the object helper cannot serialize.
 */
function stream_from_frames(frames: readonly string[], chunk_size = 9): Response {
  return chunked_sse_response(frames.map((f) => `data: ${f}\n\n`).join(''), chunk_size)
}

const frame = (event: Record<string, unknown>): string => JSON.stringify(event)

const TEXT_STREAM_EVENTS = [
  {
    type: 'message_start',
    message: {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 6 },
  },
  { type: 'message_stop' },
]

const TOOL_CALL_STREAM_EVENTS = [
  {
    type: 'message_start',
    message: {
      id: 'msg_02',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 30, output_tokens: 2 },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city"' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ': "Ottawa"}' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 18 },
  },
  { type: 'message_stop' },
]

const MIXED_STREAM_EVENTS = [
  {
    type: 'message_start',
    message: {
      id: 'msg_03',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 40,
        output_tokens: 2,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 10,
      },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'need the forecast first' },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_abc' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking the ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'weather. ' } },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'toolu_02', name: 'get_weather', input: {} },
  },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city": "King' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'ston"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'One moment.' } },
  { type: 'content_block_stop', index: 3 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 25 },
  },
  { type: 'message_stop' },
]

describe('streaming invoke_turn', () => {
  it('sets stream: true on the request body', async () => {
    const mock = stub_fetch(stream_response(TEXT_STREAM_EVENTS))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const { dispatch_chunk } = chunk_collector()
    await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk }))
    const call = mock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(call[1].body as string)['stream']).toBe(true)
  })

  it('puts provider_options.anthropic keys on the streaming wire body', async () => {
    const mock = stub_fetch(stream_response(TEXT_STREAM_EVENTS))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const { dispatch_chunk } = chunk_collector()
    await adapter.invoke_turn(
      make_req({
        stream: true,
        dispatch_chunk,
        provider_options: { anthropic: { max_tokens: 512, top_k: 40 } },
      }),
    )
    const call = mock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>
    expect(body['max_tokens']).toBe(512)
    expect(body['top_k']).toBe(40)
    expect(body['stream']).toBe(true)
  })

  it.each([
    ['text', TEXT_STREAM_EVENTS, TEXT_FIXTURE],
    ['tool-call', TOOL_CALL_STREAM_EVENTS, TOOL_CALL_FIXTURE],
    ['mixed', MIXED_STREAM_EVENTS, MIXED_FIXTURE],
  ])(
    'streamed %s result equals the non-streamed parse of the same fixture',
    async (_label, stream_events, response_fixture) => {
      stub_fetch(stream_response(stream_events))
      const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
      const { dispatch_chunk } = chunk_collector()
      const streamed = await adapter.invoke_turn(
        make_req({ stream: true, dispatch_chunk }),
      )
      expect(streamed).toEqual(parse_messages_response(response_fixture))
    },
  )

  it('dispatches the exact chunk sequence for the mixed fixture', async () => {
    stub_fetch(stream_response(MIXED_STREAM_EVENTS))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const { chunks, dispatch_chunk } = chunk_collector()
    await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk, step_index: 3 }))
    expect(chunks).toEqual([
      { kind: 'reasoning', text: 'need the forecast first', step_index: 3 },
      { kind: 'text', text: 'Checking the ', step_index: 3 },
      { kind: 'text', text: 'weather. ', step_index: 3 },
      { kind: 'tool_call_start', id: 'toolu_02', name: 'get_weather', step_index: 3 },
      { kind: 'tool_call_input_delta', id: 'toolu_02', delta: '{"city": "King', step_index: 3 },
      { kind: 'tool_call_input_delta', id: 'toolu_02', delta: 'ston"}', step_index: 3 },
      { kind: 'tool_call_end', id: 'toolu_02', input: { city: 'Kingston' }, step_index: 3 },
      { kind: 'text', text: 'One moment.', step_index: 3 },
      {
        kind: 'step_finish',
        step_index: 3,
        finish_reason: 'tool_calls',
        usage: {
          input_tokens: 150,
          output_tokens: 25,
          cached_input_tokens: 100,
          cache_write_tokens: 10,
        },
      },
    ])
  })

  it('survives byte splits inside multi-byte UTF-8 sequences', async () => {
    const events = [
      TEXT_STREAM_EVENTS[0] as Record<string, unknown>,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'héllo ☂ café' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]
    stub_fetch(stream_response(events, 3))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const { dispatch_chunk } = chunk_collector()
    const result = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk }))
    expect(result.text).toBe('héllo ☂ café')
  })

  it('streams without a dispatch_chunk consumer and still aggregates the result', async () => {
    stub_fetch(stream_response(TEXT_STREAM_EVENTS))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const result = await adapter.invoke_turn(make_req({ stream: true }))
    expect(result).toEqual(parse_messages_response(TEXT_FIXTURE))
  })

  it('maps an undelta-ed tool_use block to its start-event input', async () => {
    const events = [
      TOOL_CALL_STREAM_EVENTS[0] as Record<string, unknown>,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_09', name: 'get_weather', input: {} },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]
    stub_fetch(stream_response(events))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const { chunks, dispatch_chunk } = chunk_collector()
    const result = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk }))
    expect(result.tool_calls).toEqual([{ id: 'toolu_09', name: 'get_weather', input: {} }])
    expect(chunks[1]).toEqual({
      kind: 'tool_call_end',
      id: 'toolu_09',
      input: {},
      step_index: 0,
    })
  })

  it('throws provider_error when accumulated tool input is not valid JSON', async () => {
    const events = [
      TOOL_CALL_STREAM_EVENTS[0] as Record<string, unknown>,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city": ' } },
      { type: 'content_block_stop', index: 0 },
    ]
    stub_fetch(stream_response(events))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const { dispatch_chunk } = chunk_collector()
    const err: unknown = await adapter
      .invoke_turn(make_req({ stream: true, dispatch_chunk }))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toContain('get_weather')
  })

  it('throws provider_error when a block event is missing its index', async () => {
    const events = [
      TEXT_STREAM_EVENTS[0] as Record<string, unknown>,
      { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    ]
    stub_fetch(stream_response(events))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    await expect(
      adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} })),
    ).rejects.toThrow(/missing its block index/)
  })

  it('maps a mid-stream overloaded_error to a 529 shape the classifier retries', async () => {
    const events = [
      TEXT_STREAM_EVENTS[0] as Record<string, unknown>,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]
    stub_fetch(stream_response(events))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter
      .invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
      .catch((e: unknown) => e)
    expect((err as Error).message).toBe('anthropic stream error (overloaded_error): Overloaded')
    const classified = classify_provider_error(err) as Record<string, unknown>
    expect(classified['kind']).toBe('provider_5xx')
    expect(classified['status']).toBe(529)
  })

  it('surfaces an unrecognized mid-stream error type as a permanent provider_error', async () => {
    const events = [
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad turn' } },
    ]
    stub_fetch(stream_response(events))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter
      .invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe(
      'anthropic stream error (invalid_request_error): bad turn',
    )
    expect(classify_provider_error(err)).toBe(err)
  })

  it('throws provider_error when the stream ends before message_stop', async () => {
    const truncated = TEXT_STREAM_EVENTS.slice(0, -1)
    stub_fetch(stream_response(truncated))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    await expect(
      adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} })),
    ).rejects.toThrow(/message_stop/)
  })

  it('propagates a rejecting dispatch_chunk without wrapping it', async () => {
    const consumer_error = new Error('consumer exploded')
    stub_fetch(stream_response(TEXT_STREAM_EVENTS))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    await expect(
      adapter.invoke_turn(
        make_req({
          stream: true,
          dispatch_chunk: async () => {
            throw consumer_error
          },
        }),
      ),
    ).rejects.toBe(consumer_error)
  })
})

/**
 * OpenRouter's Anthropic-compatible Messages endpoint closes every stream with
 * a chat-completions trailer after message_stop. A stream that ends that
 * way has to give the same turn as one that doesn't, from the adapter and from
 * the engine above it.
 */
describe("OpenRouter's [DONE] trailer", () => {
  const DONE_TRAILER = 'event: data\ndata: [DONE]\n\n'

  it.each([
    ['text', TEXT_STREAM_EVENTS],
    ['tool-call', TOOL_CALL_STREAM_EVENTS],
    ['mixed', MIXED_STREAM_EVENTS],
  ])('completes a streamed %s turn the same as the stream without it', async (_label, events) => {
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    stub_fetch(stream_response(events))
    const plain = chunk_collector()
    const expected = await adapter.invoke_turn(
      make_req({ stream: true, dispatch_chunk: plain.dispatch_chunk }),
    )
    stub_fetch(stream_response(events, 9, DONE_TRAILER))
    const trailed = chunk_collector()
    const result = await adapter.invoke_turn(
      make_req({ stream: true, dispatch_chunk: trailed.dispatch_chunk }),
    )
    expect(result).toStrictEqual(expected)
    expect(trailed.chunks).toStrictEqual(plain.chunks)
  })

  it('completes a turn streamed through the engine the same as the stream without it', async () => {
    const run = async (tail: string): Promise<{ result: unknown; chunks: StreamChunk[] }> => {
      stub_fetch(stream_response(TEXT_STREAM_EVENTS, 9, tail))
      const engine = create_engine({
        providers: { anthropic: { api_key: 'sk-test', transport: 'native' } },
        pricing: {
          'anthropic:claude-sonnet-5': { input_per_million: 10, output_per_million: 20 },
        },
      })
      const chunks: StreamChunk[] = []
      const { timing: _call, ...result } = await engine.generate({
        model: 'claude-sonnet-5',
        prompt: 'hi',
        on_chunk: (chunk) => {
          chunks.push(chunk)
        },
      })
      // Wall-clock timing differs run to run; everything else must match.
      const steps = result.steps.map(({ timing: _t, ...step }) => step)
      return { result: { ...result, steps }, chunks }
    }
    const plain = await run('')
    const trailed = await run(DONE_TRAILER)
    expect(trailed).toStrictEqual(plain)
    expect(plain.chunks.map((c) => c.kind)).toEqual(['text', 'text', 'step_finish', 'finish'])
  })
})

/**
 * Boundary coverage for the streaming aggregator (create_stream_aggregator,
 * stream_event_error, read_block_index). The streamed-equals-non-streamed
 * tests above prove the happy paths; these pin the exact error/status
 * strings and drive every malformed-event guard branch. The recurring trick: a guard of the form
 * `x === null || typeof x !== 'object'` is exercised by feeding `undefined` (a
 * missing key), not null, because the guarded body then throws via
 * Reflect.get(undefined)/Object.entries(undefined), which distinguishes the
 * `typeof` operand mutant that a null value leaves equivalent.
 */
describe('streaming aggregator boundaries', () => {
  const MSG_START = {
    type: 'message_start',
    message: {
      id: 'msg_b',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  }
  const MSG_END = {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 3 },
  }
  const MSG_STOP = { type: 'message_stop' }
  // A stream that carries only the injected stray event drains to this empty
  // turn: input from message_start, output overlaid by message_delta.
  const EMPTY_TURN = {
    text: '',
    tool_calls: [],
    finish_reason: 'stop' as const,
    usage: { input_tokens: 5, output_tokens: 3 },
  }

  async function run_stream(
    events: ReadonlyArray<Record<string, unknown>>,
  ): Promise<{ result: Awaited<ReturnType<ReturnType<typeof create_anthropic_native_adapter>['invoke_turn']>>; chunks: StreamChunk[] }> {
    stub_fetch(stream_response(events))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const { chunks, dispatch_chunk } = chunk_collector()
    const result = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk }))
    return { result, chunks }
  }

  async function stream_error(events: ReadonlyArray<Record<string, unknown>>): Promise<unknown> {
    stub_fetch(stream_response(events))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    return adapter
      .invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
      .catch((e: unknown) => e)
  }

  describe('stream_event_error', () => {
    it('falls back to (unknown)/(no message) when the error object is absent', async () => {
      // No `error` key: the `error !== null && typeof error === 'object'` guard
      // stays false, so both defaults are used verbatim.
      const err = await stream_error([MSG_START, { type: 'error' }])
      expect(err).toBeInstanceOf(provider_error)
      expect((err as Error).message).toBe('anthropic stream error (unknown): (no message)')
    })

    it('keeps the defaults when type and message are empty strings', async () => {
      // An empty string is a string but has length 0, so the `.length > 0`
      // half of each guard rejects it and the default survives.
      const err = await stream_error([
        MSG_START,
        { type: 'error', error: { type: '', message: '' } },
      ])
      expect((err as Error).message).toBe('anthropic stream error (unknown): (no message)')
      expect(err).toBeInstanceOf(provider_error)
    })

    it('maps api_error to a 500 the classifier retries as provider_5xx', async () => {
      const err = await stream_error([
        MSG_START,
        { type: 'error', error: { type: 'api_error', message: 'kaboom' } },
      ])
      expect((err as Error).message).toBe('anthropic stream error (api_error): kaboom')
      expect(Reflect.get(err as object, 'status')).toBe(500)
      const classified = classify_provider_error(err) as Record<string, unknown>
      expect(classified['kind']).toBe('provider_5xx')
      expect(classified['status']).toBe(500)
    })

    it('maps rate_limit_error to a 429 the classifier retries as rate_limit', async () => {
      const err = await stream_error([
        MSG_START,
        { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      ])
      expect((err as Error).message).toBe('anthropic stream error (rate_limit_error): slow down')
      expect(Reflect.get(err as object, 'status')).toBe(429)
      const classified = classify_provider_error(err) as Record<string, unknown>
      expect(classified['kind']).toBe('rate_limit')
      expect(classified['status']).toBe(429)
    })
  })

  describe('malformed-event guards', () => {
    // '[done]' sits beside the [DONE] sentinel the parser skips, so only that
    // exact line is let through.
    it.each(['{ not json', '[done]'])('rejects invalid JSON %j in a data frame with the exact message', async (data) => {
      stub_fetch(stream_from_frames([data]))
      const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
      const err: unknown = await adapter
        .invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(provider_error)
      expect((err as Error).message).toBe('anthropic native: stream event is not valid JSON')
    })

    it('skips a null event and still drains the rest of the stream', async () => {
      // JSON.parse('null') is null: the `event === null` guard drops it before
      // the switch touches Reflect.get(null, 'type').
      stub_fetch(
        stream_from_frames([
          frame(MSG_START),
          frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
          'null',
          frame({ type: 'content_block_stop', index: 0 }),
          frame(MSG_END),
          frame(MSG_STOP),
        ]),
      )
      const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
      const { dispatch_chunk } = chunk_collector()
      const result = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk }))
      expect(result.text).toBe('Hi')
    })

    it('skips a content_block_start whose content_block key is missing', async () => {
      const { result } = await run_stream([
        MSG_START,
        { type: 'content_block_start', index: 0 },
        MSG_END,
        MSG_STOP,
      ])
      expect(result).toStrictEqual(EMPTY_TURN)
    })

    it('skips a content_block_delta whose delta key is missing', async () => {
      const { result } = await run_stream([
        MSG_START,
        { type: 'content_block_delta', index: 0 },
        MSG_END,
        MSG_STOP,
      ])
      expect(result).toStrictEqual(EMPTY_TURN)
    })

    it('drops a text_delta that targets an unopened block index', async () => {
      const { result, chunks } = await run_stream([
        MSG_START,
        { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'ghost' } },
        MSG_END,
        MSG_STOP,
      ])
      expect(result).toStrictEqual(EMPTY_TURN)
      expect(chunks.some((c) => c.kind === 'text')).toBe(false)
    })

    it('drops an input_json_delta that targets an unopened block index', async () => {
      const { result, chunks } = await run_stream([
        MSG_START,
        {
          type: 'content_block_delta',
          index: 9,
          delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
        },
        MSG_END,
        MSG_STOP,
      ])
      expect(result).toStrictEqual(EMPTY_TURN)
      expect(chunks.some((c) => c.kind === 'tool_call_input_delta')).toBe(false)
    })

    it('skips a message_start whose message key is missing', async () => {
      // message_start with no message: merge_usage is never called, so the
      // turn keeps only the message_delta output tokens.
      const { result } = await run_stream([
        { type: 'message_start' },
        MSG_END,
        MSG_STOP,
      ])
      expect(result).toStrictEqual({
        text: '',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { input_tokens: 0, output_tokens: 3 },
      })
    })

    it('skips a message_delta with neither delta nor usage', async () => {
      // The bare delta exercises both the `delta` object guard and
      // merge_usage's `raw` guard against undefined in one event.
      const { result } = await run_stream([
        MSG_START,
        { type: 'message_delta' },
        MSG_STOP,
      ])
      expect(result).toStrictEqual({
        text: '',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { input_tokens: 5, output_tokens: 1 },
      })
    })
  })

  describe('aggregator state machine', () => {
    it('keeps an earlier stop_reason when a later message_delta carries a non-string one', async () => {
      // The second delta's stop_reason is null, so `typeof raw === 'string'`
      // rejects it and the tool_use reason set by the first delta stands.
      const { result } = await run_stream([
        MSG_START,
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
        { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 4 } },
        MSG_STOP,
      ])
      expect(result.finish_reason).toBe('tool_calls')
    })

    it('drops a non-numeric output_tokens overlay, keeping the message_start count', async () => {
      // merge_usage copies numbers only; a nested container on output_tokens is
      // skipped, so the mapped usage keeps the message_start value.
      const { result } = await run_stream([
        MSG_START,
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: { nested: 1 } } },
        MSG_STOP,
      ])
      expect(result.usage).toStrictEqual({ input_tokens: 5, output_tokens: 1 })
    })

    it('seeds a text block from a non-empty start-event text', async () => {
      const { result } = await run_stream([
        MSG_START,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Seed' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ed' } },
        { type: 'content_block_stop', index: 0 },
        MSG_END,
        MSG_STOP,
      ])
      expect(result.text).toBe('Seeded')
    })

    it('falls back to an empty string when start-event text is not a string', async () => {
      const { result } = await run_stream([
        MSG_START,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 42 } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'X' } },
        { type: 'content_block_stop', index: 0 },
        MSG_END,
        MSG_STOP,
      ])
      expect(result.text).toBe('X')
    })

    it('throws the exact message on a stream tool_use block with a non-string id', async () => {
      const err = await stream_error([
        MSG_START,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 42, name: 'get_weather', input: {} },
        },
      ])
      expect(err).toBeInstanceOf(provider_error)
      expect((err as Error).message).toBe('anthropic native: malformed tool_use block in stream')
    })

    it('throws on a stream tool_use block whose name is not a string', async () => {
      // The `|| typeof name !== 'string'` half of the guard: a valid id beside a
      // non-string name must still throw.
      const err = await stream_error([
        MSG_START,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_x', name: 99, input: {} },
        },
      ])
      expect(err).toBeInstanceOf(provider_error)
      expect((err as Error).message).toBe('anthropic native: malformed tool_use block in stream')
    })

    it('defaults a start-event tool_use input to {} when the input key is missing', async () => {
      const { result } = await run_stream([
        MSG_START,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_x', name: 'get_weather' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        MSG_STOP,
      ])
      expect(result.tool_calls).toStrictEqual([
        { id: 'toolu_x', name: 'get_weather', input: {} },
      ])
    })

    it('carries a start-event tool_use input through when no delta arrives', async () => {
      const { result } = await run_stream([
        MSG_START,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_x', name: 'get_weather', input: { seeded: true } },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        MSG_STOP,
      ])
      expect(result.tool_calls).toStrictEqual([
        { id: 'toolu_x', name: 'get_weather', input: { seeded: true } },
      ])
    })

    it('dispatches no reasoning chunk for a non-string thinking delta', async () => {
      const { chunks } = await run_stream([
        MSG_START,
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 42 } },
        { type: 'content_block_stop', index: 0 },
        MSG_END,
        MSG_STOP,
      ])
      expect(chunks.some((c) => c.kind === 'reasoning')).toBe(false)
    })

    it('ignores a non-input_json delta arriving on an open tool block', async () => {
      // A delta of a kind the aggregator doesn't know is dropped: the tool
      // input stays its start value even though the stray delta carries a
      // partial_json string. (signature_delta has a handler of its own now.)
      const { result } = await run_stream([
        MSG_START,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_x', name: 'get_weather', input: {} },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', partial_json: '{"seeded":1}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        MSG_STOP,
      ])
      expect(result.tool_calls).toStrictEqual([
        { id: 'toolu_x', name: 'get_weather', input: {} },
      ])
    })
  })
})

/** A plain-text (non-JSON) error Response the adapter turns into a snippet. */
function text_response(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })
}

/** A non-2xx Response whose body read rejects, so `body` stays its '' seed. */
function failing_text_response(status: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('body stream already read'))
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/plain' } })
}

describe('error body extraction (extract_error_message via response_error)', () => {
  async function error_message(): Promise<string> {
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    return (err as Error).message
  }

  it('reports (empty body) for a zero-length error body', async () => {
    stub_fetch(text_response('', 400))
    expect(await error_message()).toBe('anthropic API error 400: (empty body)')
  })

  it('keeps the (empty body) sentinel when the body read itself throws', async () => {
    stub_fetch(failing_text_response(500))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect((err as Error).message).toBe('anthropic API error 500: (empty body)')
    expect(Reflect.get(err as object, 'status')).toBe(500)
  })

  it('returns the exact error.message from a well-formed error envelope', async () => {
    stub_fetch(
      text_response(JSON.stringify({ type: 'error', error: { message: 'model is overloaded' } }), 400),
    )
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect((err as Error).message).toBe('anthropic API error 400: model is overloaded')
  })

  it('falls back to the raw snippet when error.message is an empty string', async () => {
    const body = JSON.stringify({ type: 'error', error: { message: '' } })
    stub_fetch(text_response(body, 400))
    expect(await error_message()).toBe(`anthropic API error 400: ${body}`)
  })

  it('falls back to the raw snippet when error.message is not a string', async () => {
    const body = JSON.stringify({ error: { message: [1, 2] } })
    stub_fetch(text_response(body, 400))
    expect(await error_message()).toBe(`anthropic API error 400: ${body}`)
  })

  it('returns a short non-JSON body verbatim, without the truncation ellipsis', async () => {
    stub_fetch(text_response('<html>502 Bad Gateway</html>', 400))
    expect(await error_message()).toBe('anthropic API error 400: <html>502 Bad Gateway</html>')
  })

  it('returns a body of exactly 300 chars in full (boundary: not truncated)', async () => {
    const body = 'y'.repeat(300)
    stub_fetch(text_response(body, 400))
    expect(await error_message()).toBe(`anthropic API error 400: ${body}`)
  })

  it('truncates an oversized non-JSON body to 300 chars plus an ellipsis', async () => {
    const body = 'x'.repeat(350)
    stub_fetch(text_response(body, 400))
    expect(await error_message()).toBe(
      `anthropic API error 400: ${'x'.repeat(300)}...`,
    )
  })
})

describe('response_error status classification (raw shapes)', () => {
  async function invoke_error(response: Response): Promise<unknown> {
    stub_fetch(response)
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    return adapter.invoke_turn(make_req()).catch((e: unknown) => e)
  }

  it('gives a 429 a retry-after passthrough, not a permanent provider_error', async () => {
    const err = await invoke_error(
      json_response({ type: 'error', error: { message: 'slow down' } }, 429, { 'retry-after': '2' }),
    )
    expect(err).not.toBeInstanceOf(provider_error)
    expect(Reflect.get(err as object, 'status')).toBe(429)
    expect(Reflect.get(err as object, 'responseHeaders')).toStrictEqual({ 'retry-after': '2' })
  })

  it('treats an exactly-500 status as a retryable shape carrying its retry-after', async () => {
    const err = await invoke_error(
      json_response({ type: 'error', error: { message: 'boom' } }, 500, { 'retry-after': '3' }),
    )
    expect(err).not.toBeInstanceOf(provider_error)
    expect(Reflect.get(err as object, 'status')).toBe(500)
    expect(Reflect.get(err as object, 'responseHeaders')).toStrictEqual({ 'retry-after': '3' })
  })

  it('omits responseHeaders entirely on a 5xx that carries no retry-after', async () => {
    const err = await invoke_error(json_response({ type: 'error', error: { message: 'boom' } }, 500))
    expect(Reflect.get(err as object, 'status')).toBe(500)
    expect(Reflect.get(err as object, 'responseHeaders')).toBeUndefined()
    expect(classify_provider_error(err)).toStrictEqual({
      kind: 'provider_5xx',
      status: 500,
      message: 'anthropic API error 500: boom',
    })
  })
})

/** A 200 streaming Response with a literally null body. */
function null_body_stream_response(): Response {
  return new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A streaming Response whose first read rejects, modelling a transport drop. */
function erroring_stream_response(err: Error): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(err)
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * A streaming Response that records a reader.cancel(). Enqueues every frame then
 * closes, so an early aggregator throw leaves later chunks queued and the
 * finally's cancel() propagates to this source handler.
 */
function cancel_tracking_stream_response(
  events: ReadonlyArray<Record<string, unknown>>,
  on_cancel: () => void,
): Response {
  const bytes = new TextEncoder().encode(sse_payload(events))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 9) controller.enqueue(bytes.slice(i, i + 9))
      controller.close()
    },
    cancel() {
      on_cancel()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * A streaming Response whose final event's data line is left unterminated (no
 * trailing blank line), so only the drain tail (`sse.flush()`) emits it.
 */
function tail_event_stream_response(events: ReadonlyArray<Record<string, unknown>>): Response {
  const head = events.slice(0, -1)
  const last = events[events.length - 1]
  const payload =
    head.map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('') +
    `event: ${String(last?.['type'])}\ndata: ${JSON.stringify(last)}\n`
  const bytes = new TextEncoder().encode(payload)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 9) controller.enqueue(bytes.slice(i, i + 9))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('consume_sse_response drain lifecycle', () => {
  const STREAM_HEAD = {
    type: 'message_start',
    message: {
      id: 'msg_d',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 7, output_tokens: 1 },
    },
  }

  it('throws provider_error with its exact message when the stream has no body', async () => {
    stub_fetch(null_body_stream_response())
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter
      .invoke_turn(make_req({ stream: true }))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe('anthropic native: streaming response has no body')
  })

  it('wraps a mid-read transport failure as a kind:network error', async () => {
    stub_fetch(erroring_stream_response(new TypeError('connection reset')))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter
      .invoke_turn(make_req({ stream: true }))
      .catch((e: unknown) => e)
    expect(Reflect.get(err as object, 'kind')).toBe('network')
    expect((err as Error).message).toBe('anthropic native: network failure: connection reset')
  })

  it('cancels the reader when an aggregator throw exits the drain loop early', async () => {
    let cancelled = false
    const events = [
      { type: 'error', error: { type: 'api_error', message: 'mid-stream boom' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(200) } },
    ]
    stub_fetch(cancel_tracking_stream_response(events, () => {
      cancelled = true
    }))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const err: unknown = await adapter
      .invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
      .catch((e: unknown) => e)
    await Promise.resolve()
    expect(Reflect.get(err as object, 'status')).toBe(500)
    expect(cancelled).toBe(true)
  })

  it('drains a final event delivered only by the flush tail', async () => {
    const events = [
      STREAM_HEAD,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tail-flushed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]
    stub_fetch(tail_event_stream_response(events))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const result = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
    expect(result).toEqual({
      text: 'tail-flushed',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 7, output_tokens: 4 },
    })
  })

  it('reassembles multi-byte UTF-8 text split at every single-byte boundary', async () => {
    const events = [
      STREAM_HEAD,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'héllo ☂ café 日本語' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]
    stub_fetch(stream_response(events, 1))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    const result = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
    expect(result.text).toBe('héllo ☂ café 日本語')
  })
})

describe('create_anthropic_native_adapter config', () => {
  it('throws engine_config_error with exact message and provider on an empty api_key', () => {
    const err = capture(() => create_anthropic_native_adapter({ api_key: '' }))
    expect(err).toBeInstanceOf(engine_config_error)
    expect((err as Error).message).toBe('anthropic provider requires a non-empty api_key')
    expect((err as engine_config_error).provider).toBe('anthropic')
  })

  it('throws engine_config_error when api_key is absent (non-string coerces to empty)', () => {
    const err = capture(() => create_anthropic_native_adapter({}))
    expect(err).toBeInstanceOf(engine_config_error)
    expect((err as Error).message).toBe('anthropic provider requires a non-empty api_key')
  })

  it('falls back to the default base_url when the override is an empty string', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test', base_url: '' })
    await adapter.invoke_turn(make_req())
    expect((mock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'https://api.anthropic.com/v1/messages',
    )
  })

  it('strips every trailing slash from a base_url, not just the last one', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_anthropic_native_adapter({
      api_key: 'sk-test',
      base_url: 'https://proxy.local/v1///',
    })
    await adapter.invoke_turn(make_req())
    expect((mock.mock.calls[0] as [string, RequestInit])[0]).toBe('https://proxy.local/v1/messages')
  })
})

// ---------------------------------------------------------------------------
// Thinking blocks kept and sent back. Every thinking and
// redacted_thinking block goes back complete and in block order, empty text
// included, since Anthropic refuses a tool-use turn whose blocks moved.
// ---------------------------------------------------------------------------

const INTERLEAVED_FIXTURE = {
  id: 'msg_04',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [
    { type: 'thinking', thinking: 'need the city', signature: 'sig_1' },
    { type: 'text', text: 'Checking.' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'thinking', thinking: '', signature: 'sig_2' },
    { type: 'tool_use', id: 'toolu_04', name: 'get_weather', input: { city: 'Ottawa' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 20, output_tokens: 9 },
}

const INTERLEAVED_STREAM_EVENTS = [
  {
    type: 'message_start',
    message: { id: 'msg_04', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 1 } },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'need ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'the city' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_1' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking', data: 'opaque' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'thinking_delta', thinking: '' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'signature_delta', signature: 'sig_2' } },
  { type: 'content_block_stop', index: 3 },
  {
    type: 'content_block_start',
    index: 4,
    content_block: { type: 'tool_use', id: 'toolu_04', name: 'get_weather', input: {} },
  },
  { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"city":"Ottawa"}' } },
  { type: 'content_block_stop', index: 4 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  { type: 'message_stop' },
]

const INTERLEAVED_RESULT = {
  text: 'Checking.',
  tool_calls: [{ id: 'toolu_04', name: 'get_weather', input: { city: 'Ottawa' } }],
  finish_reason: 'tool_calls',
  usage: { input_tokens: 20, output_tokens: 9 },
  content: [
    { type: 'reasoning', text: 'need the city', provider_options: { anthropic: { signature: 'sig_1' } } },
    { type: 'text', text: 'Checking.' },
    { type: 'reasoning', text: '', provider_options: { anthropic: { redactedData: 'opaque' } } },
    { type: 'reasoning', text: '', provider_options: { anthropic: { signature: 'sig_2' } } },
    { type: 'tool_call', id: 'toolu_04', name: 'get_weather', input: { city: 'Ottawa' } },
  ],
}

/** Stream one turn's events through the adapter, collecting its chunks. */
async function stream_turn(
  events: ReadonlyArray<Record<string, unknown>>,
): Promise<{ result: Awaited<ReturnType<ReturnType<typeof create_anthropic_native_adapter>['invoke_turn']>>; chunks: StreamChunk[] }> {
  stub_fetch(stream_response(events))
  const { chunks, dispatch_chunk } = chunk_collector()
  const result = await create_anthropic_native_adapter({ api_key: 'sk-test' }).invoke_turn(
    make_req({ stream: true, dispatch_chunk }),
  )
  return { result, chunks }
}

describe('thinking blocks on anthropic native', () => {
  it('keeps interleaved, empty, and redacted blocks in order, streamed and not', async () => {
    expect(parse_messages_response(INTERLEAVED_FIXTURE)).toStrictEqual(INTERLEAVED_RESULT)
    const { result, chunks } = await stream_turn(INTERLEAVED_STREAM_EVENTS)
    expect(result).toStrictEqual(INTERLEAVED_RESULT)
    expect(chunks.filter((chunk) => chunk.kind === 'reasoning')).toStrictEqual([
      { kind: 'reasoning', text: 'need ', step_index: 0 },
      { kind: 'reasoning', text: 'the city', step_index: 0 },
      { kind: 'reasoning', text: '', step_index: 0 },
    ])
  })

  it('keeps the start signature until a signature delta replaces it, and none when neither came', async () => {
    const start = INTERLEAVED_STREAM_EVENTS[0] as Record<string, unknown>
    const { result } = await stream_turn([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'a', signature: 'early' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'b', signature: 'early' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'late' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 42 } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'thinking' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ])
    expect(result.content).toStrictEqual([
      { type: 'reasoning', text: 'a', provider_options: { anthropic: { signature: 'early' } } },
      { type: 'reasoning', text: 'b', provider_options: { anthropic: { signature: 'late' } } },
      { type: 'reasoning', text: '' },
    ])
  })

  it('streams a thinking delta with no open block without growing any block, and ignores a stray signature', async () => {
    const start = INTERLEAVED_STREAM_EVENTS[0] as Record<string, unknown>
    const { result, chunks } = await stream_turn([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'kept', signature: 's' } },
      { type: 'content_block_stop', index: 0 },
      // After its stop, index 0 is closed: the delta streams but the block stays.
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' late' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'stray' } },
      { type: 'content_block_delta', index: 9, delta: { type: 'thinking_delta', thinking: 'orphan' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ])
    expect(result.content).toStrictEqual([
      { type: 'reasoning', text: 'kept', provider_options: { anthropic: { signature: 's' } } },
    ])
    expect(
      chunks.flatMap((chunk) => (chunk.kind === 'reasoning' ? [chunk.text] : [])),
    ).toStrictEqual([' late', 'orphan'])
  })

  it('grows a thinking block whose start carried no text from its deltas', async () => {
    const start = INTERLEAVED_STREAM_EVENTS[0] as Record<string, unknown>
    const { result } = await stream_turn([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', signature: 's' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'grown' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ])
    expect(result.content).toStrictEqual([
      { type: 'reasoning', text: 'grown', provider_options: { anthropic: { signature: 's' } } },
    ])
  })

  it('keeps a start of a type it does not read as an opaque part, dispatching nothing for it', async () => {
    const start = INTERLEAVED_STREAM_EVENTS[0] as Record<string, unknown>
    const { result, chunks } = await stream_turn([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'hi' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ])
    expect(result).toStrictEqual({
      text: 'hi',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 20, output_tokens: 1 },
      content: [
        { type: 'opaque', provider_options: { anthropic: { block: { type: 'server_tool_use', id: 'srv_1' } } } },
        { type: 'text', text: 'hi' },
      ],
    })
    expect(chunks.map((c) => c.kind)).toStrictEqual(['step_finish'])
  })

  it('reads a redacted block whose data is missing as a part with no data', async () => {
    const start = INTERLEAVED_STREAM_EVENTS[0] as Record<string, unknown>
    const { result } = await stream_turn([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ])
    expect(result.content).toStrictEqual([{ type: 'reasoning', text: '' }])
  })

  // The one first-party response this
  // machine can get, captured through `claude -p --include-partial-messages`
  // on 2026-10-16. Its display was omitted, so the thinking text is empty and
  // only the signature carries the block.
  it('parses the captured first-party tool turn into a signed reasoning part, then the call', async () => {
    const sse = readFileSync(
      new URL('./fixtures/anthropic_thinking_tool_turn.sse', import.meta.url),
      'utf8',
    )
    const signature = /"signature_delta","signature":"([^"]+)"/.exec(sse)?.[1]
    expect(signature).toMatch(/^[A-Za-z0-9+/=]{1000,}$/)
    stub_fetch(chunked_sse_response(sse, 64))
    const { chunks, dispatch_chunk } = chunk_collector()
    const result = await create_anthropic_native_adapter({ api_key: 'sk-test' }).invoke_turn(
      make_req({ stream: true, dispatch_chunk }),
    )
    const call = {
      id: 'toolu_01AsXfyDdH1r8Jc7GNBeyr65',
      name: 'Bash',
      input: { command: 'echo 3758', description: 'Print the computed answer' },
    }
    expect(result.finish_reason).toBe('tool_calls')
    expect(result.tool_calls).toStrictEqual([call])
    expect(result.content).toStrictEqual([
      { type: 'reasoning', text: '', provider_options: { anthropic: { signature } } },
      { type: 'tool_call', ...call },
    ])
    expect(chunks.map((chunk) => chunk.kind)[0]).toBe('reasoning')
    // Sent back, the block is exactly what arrived.
    expect(
      to_anthropic_messages([{ role: 'assistant', content: [...(result.content ?? [])] }]).messages,
    ).toStrictEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature },
          { type: 'tool_use', ...call },
        ],
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// Server tools: blocks the adapter doesn't read ride back as opaque parts,
// cited text keeps its citations, and a pause_turn continues. The fixtures are
// transcribed from the web search example in Anthropic's streaming docs, with
// a citations_delta added (see fixtures/anthropic_web_search.ts).
// ---------------------------------------------------------------------------

describe('anthropic native web search: opaque blocks and citations', () => {
  const CONTENT = (web_search_json()['content'] as Array<Record<string, unknown>>)

  /** The assistant blocks a turn's content maps back to on the next request. */
  function sent_back(content: ReadonlyArray<AssistantContentPart> | undefined): unknown {
    return to_anthropic_messages([
      { role: 'user', content: 'weather in NYC?' },
      { role: 'assistant', content: [...(content ?? [])] },
    ]).messages[1]?.content
  }

  it('reads the whole response into text, opaque, and cited parts, and skips an opaque part not its own', () => {
    const whole = parse_messages_response(web_search_json())
    expect(whole.text).toBe(
      "I'll check the current weather in New York City for you." +
        "Here's the current weather information for New York City:\n\n# Weather in New York City\n\n" +
        'It is mild and clear today.',
    )
    expect(whole.tool_calls).toStrictEqual([])
    expect(whole.content).toStrictEqual([
      { type: 'text', text: CONTENT[0]?.['text'] },
      { type: 'opaque', provider_options: { anthropic: { block: CONTENT[1] } } },
      { type: 'opaque', provider_options: { anthropic: { block: CONTENT[2] } } },
      { type: 'text', text: CONTENT[3]?.['text'] },
      { type: 'text', text: CONTENT[4]?.['text'], provider_options: { anthropic: { citations: CONTENT[4]?.['citations'] } } },
    ])
    expect('paused' in whole).toBe(false)

    // An opaque part that carries another provider's block, or none, maps to no block.
    expect(
      sent_back([
        { type: 'opaque', provider_options: { openai: { block: { type: 'web_search_call' } } } },
        { type: 'opaque', provider_options: { anthropic: { block: 'not a block' } } },
        { type: 'opaque', provider_options: { anthropic: {} } },
        { type: 'text', text: 'hi' },
      ]),
    ).toStrictEqual([{ type: 'text', text: 'hi' }])
  })

  it('round-trips every block byte for byte, whole and streamed, and streams no chunk for an opaque block', async () => {
    const whole = parse_messages_response(web_search_json())
    stub_fetch(web_search_sse_response())
    const { chunks, dispatch_chunk } = chunk_collector()
    const streamed = await create_anthropic_native_adapter({ api_key: 'sk-test' }).invoke_turn(
      make_req({ stream: true, dispatch_chunk }),
    )

    expect(streamed).toStrictEqual(whole)
    expect(JSON.stringify(sent_back(whole.content))).toBe(JSON.stringify(CONTENT))
    expect(JSON.stringify(sent_back(streamed.content))).toBe(JSON.stringify(CONTENT))
    expect(new Set(chunks.map((c) => c.kind))).toStrictEqual(new Set(['text', 'step_finish']))
  })

  it('sets paused on a pause_turn, beside a stop finish', async () => {
    const whole = parse_messages_response(web_search_json('pause_turn'))
    expect([whole.finish_reason, whole.paused]).toStrictEqual(['stop', true])
    stub_fetch(web_search_sse_response('pause_turn'))
    const { dispatch_chunk } = chunk_collector()
    const streamed = await create_anthropic_native_adapter({ api_key: 'sk-test' }).invoke_turn(
      make_req({ stream: true, dispatch_chunk }),
    )
    expect(streamed).toStrictEqual(whole)
  })

  it('continues a paused turn through the loop, sending its blocks back as they came with nothing after them', async () => {
    const final = {
      ...web_search_json(),
      content: [{ type: 'text', text: ' It stays mild tonight.' }],
      usage: { input_tokens: 20, output_tokens: 6 },
    }
    const responses = [
      web_search_sse_response('pause_turn'),
      new Response(JSON.stringify(final), { status: 200, headers: { 'content-type': 'application/json' } }),
    ]
    const mock = vi.fn(async () => {
      const next = responses.shift()
      if (next === undefined) throw new Error('fetch queue exhausted')
      return next
    })
    vi.stubGlobal('fetch', mock)
    const events: Array<Record<string, unknown>> = []
    const result = await create_engine({
      providers: { anthropic: { api_key: 'sk-test', transport: 'native' } },
    }).generate({
      model: 'claude-opus-5-5',
      prompt: 'weather in NYC?',
      trajectory: {
        record: (e) => {
          events.push(e)
        },
        start_span: () => 'span-step',
        end_span: () => {},
      },
    })

    expect(mock).toHaveBeenCalledTimes(2)
    const second = JSON.parse((mock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string) as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(second.messages.map((m) => m.role)).toStrictEqual(['user', 'assistant'])
    expect(JSON.stringify(second.messages[1]?.content)).toBe(JSON.stringify(CONTENT))
    expect(result.content).toBe(`${parse_messages_response(web_search_json()).text} It stays mild tonight.`)
    expect(result.steps.map((step) => step.finish_reason)).toStrictEqual(['stop', 'stop'])
    expect(events.filter((e) => e['kind'] === 'turn_paused')).toStrictEqual([
      { kind: 'turn_paused', step_index: 0, span_id: 'span-step', ts: expect.any(Number) },
    ])
  })

  it('fails loud on an opaque block whose streamed input is not JSON', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    stub_fetch(stream_response(events))
    const { dispatch_chunk } = chunk_collector()
    await expect(
      create_anthropic_native_adapter({ api_key: 'sk-test' }).invoke_turn(make_req({ stream: true, dispatch_chunk })),
    ).rejects.toThrow('anthropic native: server_tool_use input is not valid JSON')
  })

})

describe('one-hour cache writes on a streamed turn', () => {
  const start_usage = {
    input_tokens: 4,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
  }

  /** The text stream with its message_start usage swapped for `usage`. */
  function events_with(usage: Record<string, unknown>): Array<Record<string, unknown>> {
    const [first, ...rest] = TEXT_STREAM_EVENTS
    const message = (first as { message: Record<string, unknown> }).message
    return [{ type: 'message_start', message: { ...message, usage } }, ...rest]
  }

  it('keeps the cache_creation split, so a stream folds to what its whole body does', async () => {
    stub_fetch(stream_response(events_with(start_usage)))
    const { dispatch_chunk } = chunk_collector()
    const adapter = create_anthropic_native_adapter({ api_key: 'k' })
    const streamed = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk }))
    expect(streamed.usage).toStrictEqual({
      input_tokens: 504,
      output_tokens: 6,
      cached_input_tokens: 0,
      cache_write_tokens: 500,
      cache_write_1h_tokens: 500,
    })
    expect(streamed.usage).toStrictEqual(map_anthropic_usage({ ...start_usage, output_tokens: 6 }))
  })

  it("keeps the start's split when a message_delta carries a null one", async () => {
    const [first, ...rest] = events_with(start_usage)
    const delta = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 6, cache_creation: null },
    }
    stub_fetch(stream_response([first as Record<string, unknown>, ...rest.slice(0, -2), delta, { type: 'message_stop' }]))
    const { dispatch_chunk } = chunk_collector()
    const adapter = create_anthropic_native_adapter({ api_key: 'k' })
    const streamed = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk }))
    expect(streamed.usage.cache_write_1h_tokens).toBe(500)
  })
})
