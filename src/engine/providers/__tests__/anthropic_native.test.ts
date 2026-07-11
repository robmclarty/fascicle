/**
 * Native Anthropic adapter (S-P3.1..P3.3, S-P3.5): request mapping, the
 * non-stream invoke_turn against golden Messages-API fixtures, and error
 * classification. No live network; fetch is stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Message, Tool, TurnRequest } from '../../types.js'
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

  it('throws provider_capability_error on a mid-conversation system message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'now be verbose' },
    ]
    expect(() => to_anthropic_messages(messages)).toThrow(provider_capability_error)
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

  it('throws provider_capability_error on image parts', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'image', image: 'aGk=', media_type: 'image/png' }],
      },
    ]
    expect(() => to_anthropic_messages(messages)).toThrow(provider_capability_error)
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
  it('copies plain input/output tokens', () => {
    expect(map_anthropic_usage({ input_tokens: 100, output_tokens: 20 })).toEqual({
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
    ).toEqual({
      input_tokens: 125,
      output_tokens: 5,
      cached_input_tokens: 90,
      cache_write_tokens: 25,
    })
  })

  it('returns zero totals for a missing usage object', () => {
    expect(map_anthropic_usage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 })
  })
})

describe('parse_messages_response', () => {
  it('parses a text response', () => {
    expect(parse_messages_response(TEXT_FIXTURE)).toEqual({
      text: 'Hello there',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 12, output_tokens: 6 },
    })
  })

  it('parses a tool-call response', () => {
    expect(parse_messages_response(TOOL_CALL_FIXTURE)).toEqual({
      text: '',
      tool_calls: [{ id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 30, output_tokens: 18 },
    })
  })

  it('parses a mixed response, joining text and skipping thinking blocks', () => {
    expect(parse_messages_response(MIXED_FIXTURE)).toEqual({
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

  it('throws provider_error on a malformed tool_use block', () => {
    const payload = {
      ...TOOL_CALL_FIXTURE,
      content: [{ type: 'tool_use', id: 42, name: 'get_weather', input: {} }],
    }
    expect(() => parse_messages_response(payload)).toThrow(provider_error)
  })

  it('throws provider_error on a non-object payload', () => {
    expect(() => parse_messages_response('nope')).toThrow(provider_error)
  })
})

describe('create_anthropic_native_adapter', () => {
  it('throws engine_config_error when api_key is missing', () => {
    expect(() => create_anthropic_native_adapter({ api_key: '' })).toThrow(engine_config_error)
  })

  it('claims text, tools, schema, and reasoning; not streaming, structured_output, or image_input', () => {
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    expect(adapter.kind).toBe('native')
    expect(adapter.name).toBe('anthropic')
    for (const cap of ['text', 'tools', 'schema', 'reasoning'] as const) {
      expect(adapter.supports(cap)).toBe(true)
    }
    for (const cap of ['streaming', 'structured_output', 'image_input'] as const) {
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

  it('rejects streaming requests until the SSE path lands', async () => {
    stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_anthropic_native_adapter({ api_key: 'sk-test' })
    await expect(
      adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} })),
    ).rejects.toThrow(provider_capability_error)
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
