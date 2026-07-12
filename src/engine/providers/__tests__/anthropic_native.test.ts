/**
 * Native Anthropic adapter (S-P3.1..P3.5): request mapping, the non-stream
 * and SSE-streamed invoke_turn against golden Messages-API fixtures, and
 * error classification. Streamed results are asserted equal to the
 * non-streamed parse of the same fixture (C4). No live network; fetch is
 * stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Message, StreamChunk, Tool, TurnRequest } from '../../types.js'
import {
  build_messages_body,
  create_anthropic_native_adapter,
  map_anthropic_stop_reason,
  map_anthropic_usage,
  parse_messages_response,
  to_anthropic_messages,
} from '../anthropic_native.js'
import { classify_provider_error } from '../../generate.js'
import {
  engine_config_error,
  provider_auth_error,
  provider_capability_error,
  provider_error,
} from '../../errors.js'

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

  it('maps effort to a thinking budget, raises default max_tokens above it, and drops sampling params', () => {
    const body = build_messages_body(make_req({ effort: 'medium', temperature: 0.2 }))
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 5000 })
    expect(body['max_tokens']).toBe(9096)
    expect(body).not.toHaveProperty('temperature')
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

  it('maps tools to Messages-API shape via z.toJSONSchema', () => {
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

  it('applies only temperature when top_p is unset and thinking is off', () => {
    const body = build_messages_body(make_req({ temperature: 0.5 }))
    expect(body['temperature']).toBe(0.5)
    expect(body).not.toHaveProperty('top_p')
  })

  it('applies only top_p when temperature is unset and thinking is off', () => {
    const body = build_messages_body(make_req({ top_p: 0.8 }))
    expect(body['top_p']).toBe(0.8)
    expect(body).not.toHaveProperty('temperature')
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
    // even when the source cache field is absent (D6).
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

  it('parses a mixed response, joining text and skipping thinking blocks', () => {
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
    })
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
 * including splits inside multi-byte UTF-8 sequences.
 */
function stream_response(
  events: ReadonlyArray<Record<string, unknown>>,
  chunk_size = 9,
): Response {
  const bytes = new TextEncoder().encode(sse_payload(events))
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
    'streamed %s result equals the non-streamed parse of the same fixture (C4)',
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
