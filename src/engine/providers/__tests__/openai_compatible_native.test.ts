/**
 * OpenAI-compatible native core: request mapping, the non-stream invoke_turn
 * against golden chat/completions fixtures, dialect auth strategies, error
 * classification asserted exactly as the Anthropic adapter's, and the SSE
 * streaming path — streamed results must equal non-streamed results on
 * shared fixtures (C4). No live network; fetch is stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Message, StreamChunk, Tool, TurnRequest } from '../../types.js'
import {
  build_chat_completions_body,
  create_chat_stream_aggregator,
  create_openai_compatible_adapter,
  map_chat_finish_reason,
  map_chat_usage,
  parse_chat_completion,
  to_chat_messages,
  to_chat_tools,
  type OpenAICompatibleDialect,
} from '../openai_compatible_native.js'
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

function make_dialect(
  overrides: Partial<OpenAICompatibleDialect> = {},
): OpenAICompatibleDialect {
  return {
    name: 'openai',
    base_url: 'https://api.openai.com/v1',
    auth: { kind: 'bearer', api_key: 'sk-test' },
    token_limit_field: 'max_completion_tokens',
    stream_include_usage: true,
    tolerant_usage: false,
    ...overrides,
  }
}

function make_req(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    step_index: 0,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    abort: new AbortController().signal,
    stream: false,
    model_id: 'gpt-test',
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
  id: 'chatcmpl-01',
  object: 'chat.completion',
  model: 'gpt-test',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello there' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
}

const TOOL_CALL_FIXTURE = {
  id: 'chatcmpl-02',
  object: 'chat.completion',
  model: 'gpt-test',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_01',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Ottawa"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 30, completion_tokens: 18, total_tokens: 48 },
}

const MIXED_FIXTURE = {
  id: 'chatcmpl-03',
  object: 'chat.completion',
  model: 'gpt-test',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'Checking the weather.',
        tool_calls: [
          {
            id: 'call_02',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Kingston"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: {
    prompt_tokens: 140,
    completion_tokens: 32,
    total_tokens: 172,
    prompt_tokens_details: { cached_tokens: 100 },
    completion_tokens_details: { reasoning_tokens: 7 },
  },
}

describe('to_chat_messages', () => {
  it('maps system messages in place, including mid-conversation', () => {
    const messages: Message[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'now be verbose' },
    ]
    expect(to_chat_messages(messages, 'openai')).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'now be verbose' },
    ])
  })

  it('keeps user string content verbatim and maps text parts to a content array', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: '   ' },
          { type: 'text', text: 'second' },
        ],
      },
    ]
    expect(to_chat_messages(messages, 'openai')).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    ])
  })

  it('maps all-empty user parts to an empty string content', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '  ' }] },
    ]
    expect(to_chat_messages(messages, 'openai')).toEqual([
      { role: 'user', content: '' },
    ])
  })

  it('throws provider_capability_error on image parts', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'image', image: 'aGk=', media_type: 'image/png' }],
      },
    ]
    expect(() => to_chat_messages(messages, 'lmstudio')).toThrow(provider_capability_error)
  })

  it('round-trips an assistant tool-call turn and its tool results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'call_01', name: 'get_weather', input: { city: 'Ottawa' } },
          { type: 'tool_call', id: 'call_02', name: 'get_weather', input: { city: 'Kingston' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_01', name: 'get_weather', content: 'sunny' },
      { role: 'tool', tool_call_id: 'call_02', name: 'get_weather', content: 'rain' },
    ]
    expect(to_chat_messages(messages, 'openai')).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_01',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Ottawa"}' },
          },
          {
            id: 'call_02',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Kingston"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_01', content: 'sunny' },
      { role: 'tool', tool_call_id: 'call_02', content: 'rain' },
    ])
  })

  it('keeps assistant prose alongside tool calls as string content', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking. ' },
          { type: 'tool_call', id: 'call_01', name: 'get_weather', input: { city: 'Ottawa' } },
          { type: 'text', text: 'One moment.' },
        ],
      },
    ]
    const mapped = to_chat_messages(messages, 'openai')
    expect(mapped[0]).toMatchObject({
      role: 'assistant',
      content: 'Checking. One moment.',
    })
  })

  it('maps a plain assistant string, keeping an empty string as content', () => {
    expect(to_chat_messages([{ role: 'assistant', content: '' }], 'openai')).toEqual([
      { role: 'assistant', content: '' },
    ])
  })
})

describe('to_chat_tools', () => {
  it('maps tools to the function-tool shape via z.toJSONSchema', () => {
    const tools = to_chat_tools([weather_tool])
    expect(tools).toHaveLength(1)
    expect(tools[0]?.type).toBe('function')
    expect(tools[0]?.function.name).toBe('get_weather')
    expect(tools[0]?.function.description).toBe('Look up current weather for a city')
    expect(tools[0]?.function.parameters).toMatchObject({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    })
  })
})

describe('build_chat_completions_body', () => {
  it('builds the minimal body, prepending TurnRequest.system as a system message', () => {
    const body = build_chat_completions_body(
      make_req({ system: 'be terse', temperature: 0.2, top_p: 0.9 }),
      make_dialect(),
    )
    expect(body).toEqual({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.2,
      top_p: 0.9,
    })
  })

  it('writes max_tokens to the dialect token-limit field', () => {
    const openai_body = build_chat_completions_body(
      make_req({ max_tokens: 1000 }),
      make_dialect(),
    )
    expect(openai_body['max_completion_tokens']).toBe(1000)
    expect(openai_body).not.toHaveProperty('max_tokens')

    const compat_body = build_chat_completions_body(
      make_req({ max_tokens: 1000 }),
      make_dialect({ token_limit_field: 'max_tokens' }),
    )
    expect(compat_body['max_tokens']).toBe(1000)
    expect(compat_body).not.toHaveProperty('max_completion_tokens')
  })

  it('omits the token-limit field when max_tokens is not set', () => {
    const body = build_chat_completions_body(make_req(), make_dialect())
    expect(body).not.toHaveProperty('max_completion_tokens')
    expect(body).not.toHaveProperty('max_tokens')
  })

  it.each([
    ['none', undefined],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
  ] as const)('maps effort %s to reasoning_effort %s (A4)', (effort, expected) => {
    const body = build_chat_completions_body(make_req({ effort }), make_dialect())
    if (expected === undefined) {
      expect(body).not.toHaveProperty('reasoning_effort')
    } else {
      expect(body['reasoning_effort']).toBe(expected)
    }
  })

  it('maps tools onto the body', () => {
    const body = build_chat_completions_body(make_req({ tools: [weather_tool] }), make_dialect())
    expect(body['tools']).toEqual(to_chat_tools([weather_tool]))
  })

  it('sets stream and stream_options.include_usage per the dialect knob', () => {
    const with_usage = build_chat_completions_body(
      make_req({ stream: true }),
      make_dialect(),
    )
    expect(with_usage['stream']).toBe(true)
    expect(with_usage['stream_options']).toEqual({ include_usage: true })

    const without_usage = build_chat_completions_body(
      make_req({ stream: true }),
      make_dialect({ stream_include_usage: false }),
    )
    expect(without_usage['stream']).toBe(true)
    expect(without_usage).not.toHaveProperty('stream_options')
  })

  it('does not set stream fields on a non-stream request', () => {
    const body = build_chat_completions_body(make_req(), make_dialect())
    expect(body).not.toHaveProperty('stream')
    expect(body).not.toHaveProperty('stream_options')
  })

  it('shallow-merges provider_options keyed by dialect name last, beating derived fields', () => {
    const body = build_chat_completions_body(
      make_req({
        effort: 'medium',
        max_tokens: 1000,
        provider_options: {
          openai: { max_completion_tokens: 512, reasoning_effort: 'high', logprobs: true },
        },
      }),
      make_dialect(),
    )
    expect(body['max_completion_tokens']).toBe(512)
    expect(body['reasoning_effort']).toBe('high')
    expect(body['logprobs']).toBe(true)
  })

  it('ignores provider_options keyed to other providers', () => {
    const body = build_chat_completions_body(
      make_req({ provider_options: { anthropic: { top_k: 40 } } }),
      make_dialect(),
    )
    expect(body).not.toHaveProperty('top_k')
  })
})

describe('map_chat_finish_reason', () => {
  it.each([
    ['stop', 'stop'],
    ['tool_calls', 'tool_calls'],
    ['length', 'length'],
    ['content_filter', 'content_filter'],
    ['function_call', 'stop'],
    ['something_new', 'stop'],
    [undefined, 'stop'],
  ])('maps %s to %s (A2)', (raw, expected) => {
    expect(map_chat_finish_reason(raw)).toBe(expected)
  })
})

describe('map_chat_usage', () => {
  it('copies prompt/completion tokens verbatim (inclusive of cached, A3)', () => {
    expect(
      map_chat_usage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, make_dialect()),
    ).toEqual({ input_tokens: 100, output_tokens: 20 })
  })

  it('maps cached_tokens and reasoning_tokens from the details containers', () => {
    expect(
      map_chat_usage(
        {
          prompt_tokens: 140,
          completion_tokens: 32,
          prompt_tokens_details: { cached_tokens: 100 },
          completion_tokens_details: { reasoning_tokens: 7 },
        },
        make_dialect(),
      ),
    ).toEqual({
      input_tokens: 140,
      output_tokens: 32,
      cached_input_tokens: 100,
      reasoning_tokens: 7,
    })
  })

  it('zeroes non-numeric token fields without inventing detail fields', () => {
    expect(
      map_chat_usage(
        { prompt_tokens: 'many', prompt_tokens_details: { cached_tokens: null } },
        make_dialect(),
      ),
    ).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('throws provider_error on absent usage under a strict dialect', () => {
    expect(() => map_chat_usage(undefined, make_dialect())).toThrow(provider_error)
    expect(() => map_chat_usage(null, make_dialect())).toThrow(/missing its usage/)
  })

  it('returns zeroed totals on absent usage under a tolerant dialect (D10)', () => {
    expect(map_chat_usage(undefined, make_dialect({ tolerant_usage: true }))).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    })
  })
})

describe('parse_chat_completion', () => {
  it('parses a text response', () => {
    expect(parse_chat_completion(TEXT_FIXTURE, make_dialect())).toEqual({
      text: 'Hello there',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 12, output_tokens: 6 },
    })
  })

  it('parses a tool-call response, decoding the JSON arguments string', () => {
    expect(parse_chat_completion(TOOL_CALL_FIXTURE, make_dialect())).toEqual({
      text: '',
      tool_calls: [{ id: 'call_01', name: 'get_weather', input: { city: 'Ottawa' } }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 30, output_tokens: 18 },
    })
  })

  it('parses a mixed response with prose, tool calls, and detail usage', () => {
    expect(parse_chat_completion(MIXED_FIXTURE, make_dialect())).toEqual({
      text: 'Checking the weather.',
      tool_calls: [{ id: 'call_02', name: 'get_weather', input: { city: 'Kingston' } }],
      finish_reason: 'tool_calls',
      usage: {
        input_tokens: 140,
        output_tokens: 32,
        cached_input_tokens: 100,
        reasoning_tokens: 7,
      },
    })
  })

  it('decodes an empty arguments string as an empty input object', () => {
    const payload = {
      ...TOOL_CALL_FIXTURE,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_03', type: 'function', function: { name: 'noop', arguments: '' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
    expect(parse_chat_completion(payload, make_dialect()).tool_calls).toEqual([
      { id: 'call_03', name: 'noop', input: {} },
    ])
  })

  it('throws provider_error when tool arguments are not valid JSON', () => {
    const payload = {
      ...TOOL_CALL_FIXTURE,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_01',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city": ' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
    const dialect = make_dialect()
    expect(() => parse_chat_completion(payload, dialect)).toThrow(provider_error)
    expect(() => parse_chat_completion(payload, dialect)).toThrow(/get_weather/)
  })

  it('throws provider_error on a malformed tool_calls entry', () => {
    const payload = {
      ...TOOL_CALL_FIXTURE,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 42, type: 'function', function: { name: 'get_weather' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
    expect(() => parse_chat_completion(payload, make_dialect())).toThrow(provider_error)
  })

  it('throws provider_error when the response has no choices', () => {
    expect(() =>
      parse_chat_completion({ ...TEXT_FIXTURE, choices: [] }, make_dialect()),
    ).toThrow(/no choices/)
  })

  it('throws provider_error when the choice has no message object', () => {
    expect(() =>
      parse_chat_completion(
        { ...TEXT_FIXTURE, choices: [{ index: 0, finish_reason: 'stop' }] },
        make_dialect(),
      ),
    ).toThrow(/no message/)
  })

  it('throws provider_error on a non-object payload', () => {
    expect(() => parse_chat_completion('nope', make_dialect())).toThrow(provider_error)
  })
})

describe('create_openai_compatible_adapter', () => {
  it('throws engine_config_error on a bearer dialect with an empty api_key', () => {
    expect(() =>
      create_openai_compatible_adapter(make_dialect({ auth: { kind: 'bearer', api_key: '' } })),
    ).toThrow(engine_config_error)
  })

  it('constructs a no-auth dialect without any key', () => {
    const adapter = create_openai_compatible_adapter(
      make_dialect({ name: 'lmstudio', auth: { kind: 'none' } }),
    )
    expect(adapter.kind).toBe('native')
    expect(adapter.name).toBe('lmstudio')
  })

  it('claims text, tools, schema, streaming, and reasoning; not structured_output or image_input', () => {
    const adapter = create_openai_compatible_adapter(make_dialect())
    for (const cap of ['text', 'tools', 'schema', 'streaming', 'reasoning'] as const) {
      expect(adapter.supports(cap)).toBe(true)
    }
    for (const cap of ['structured_output', 'image_input'] as const) {
      expect(adapter.supports(cap)).toBe(false)
    }
  })

  it('POSTs the mapped body with Bearer auth and extra headers to chat/completions', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_openai_compatible_adapter(
      make_dialect({ extra_headers: { 'openai-organization': 'org-42' } }),
    )
    const result = await adapter.invoke_turn(make_req({ system: 'be terse' }))

    expect(mock).toHaveBeenCalledTimes(1)
    const call = mock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('https://api.openai.com/v1/chat/completions')
    expect(call[1].method).toBe('POST')
    const headers = call[1].headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer sk-test')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['openai-organization']).toBe('org-42')
    expect(JSON.parse(call[1].body as string)).toEqual({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(result.text).toBe('Hello there')
  })

  it('sends no authorization header on a no-auth dialect', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_openai_compatible_adapter(
      make_dialect({
        name: 'lmstudio',
        base_url: 'http://localhost:1234/v1',
        auth: { kind: 'none' },
        token_limit_field: 'max_tokens',
        tolerant_usage: true,
      }),
    )
    await adapter.invoke_turn(make_req())
    const call = mock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('http://localhost:1234/v1/chat/completions')
    expect(call[1].headers).not.toHaveProperty('authorization')
  })

  it('respects a base_url override, trimming trailing slashes', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_openai_compatible_adapter(
      make_dialect({ base_url: 'https://proxy.local/v1/' }),
    )
    await adapter.invoke_turn(make_req())
    const call = mock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('https://proxy.local/v1/chat/completions')
  })

  it('puts provider_options wire keys on the non-stream body', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_openai_compatible_adapter(make_dialect())
    await adapter.invoke_turn(
      make_req({ provider_options: { openai: { max_completion_tokens: 512, logprobs: true } } }),
    )
    const call = mock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>
    expect(body['max_completion_tokens']).toBe(512)
    expect(body['logprobs']).toBe(true)
  })

  it('returns the parsed TurnResult for a tool-call fixture end to end', async () => {
    stub_fetch(json_response(TOOL_CALL_FIXTURE))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const result = await adapter.invoke_turn(make_req({ tools: [weather_tool] }))
    expect(result).toEqual({
      text: '',
      tool_calls: [{ id: 'call_01', name: 'get_weather', input: { city: 'Ottawa' } }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 30, output_tokens: 18 },
    })
  })

  it('throws provider_auth_error on 401 with the API error message', async () => {
    stub_fetch(
      json_response(
        { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } },
        401,
      ),
    )
    const adapter = create_openai_compatible_adapter(make_dialect({ auth: { kind: 'bearer', api_key: 'sk-bad' } }))
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_auth_error)
    expect((err as provider_auth_error).provider).toBe('openai')
    expect((err as Error).message).toBe(
      'openai authentication failed (401): Incorrect API key provided',
    )
  })

  it('throws a 429 shape the shared classifier maps to rate_limit with retry_after_ms', async () => {
    stub_fetch(
      json_response(
        { error: { message: 'Rate limit reached', type: 'rate_limit_error' } },
        429,
        { 'retry-after': '2' },
      ),
    )
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    const classified = classify_provider_error(err) as Record<string, unknown>
    expect(classified['kind']).toBe('rate_limit')
    expect(classified['status']).toBe(429)
    expect(classified['retry_after_ms']).toBe(2000)
    expect(classified['message']).toBe('openai API error 429: Rate limit reached')
  })

  it('throws a 5xx shape the shared classifier maps to provider_5xx', async () => {
    stub_fetch(
      json_response({ error: { message: 'The server is overloaded', type: 'server_error' } }, 503),
    )
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    const classified = classify_provider_error(err) as Record<string, unknown>
    expect(classified['kind']).toBe('provider_5xx')
    expect(classified['status']).toBe(503)
    expect(classified['message']).toBe('openai API error 503: The server is overloaded')
  })

  it('throws a permanent provider_error on other 4xx, untouched by classification', async () => {
    stub_fetch(
      json_response(
        { error: { message: "'gpt-nope' does not exist", type: 'invalid_request_error' } },
        404,
      ),
    )
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).status).toBe(404)
    expect((err as Error).message).toBe("openai API error 404: 'gpt-nope' does not exist")
    expect(classify_provider_error(err)).toBe(err)
  })

  it('falls back to the raw body when the error payload is not the OpenAI shape', async () => {
    stub_fetch(new Response('upstream exploded', { status: 400 }))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect((err as Error).message).toBe('openai API error 400: upstream exploded')
  })

  it('wraps transport failures as kind network for the shared classifier', async () => {
    stub_fetch(new TypeError('fetch failed'))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(Reflect.get(err as object, 'kind')).toBe('network')
    expect((err as Error).message).toBe('openai native: network failure: fetch failed')
    expect(classify_provider_error(err)).toBe(err)
  })

  it('rethrows the fetch abort error untouched when the signal aborted', async () => {
    const abort_err = new DOMException('This operation was aborted', 'AbortError')
    stub_fetch(abort_err)
    const controller = new AbortController()
    controller.abort()
    const adapter = create_openai_compatible_adapter(make_dialect())
    await expect(
      adapter.invoke_turn(make_req({ abort: controller.signal })),
    ).rejects.toBe(abort_err)
  })
})

type StreamFrame = Record<string, unknown> | '[DONE]'

/**
 * Encode frames as SSE `data:` lines and chunk the bytes at awkward
 * boundaries so the incremental decode path (mid-line, mid-frame splits) is
 * exercised, not just whole-event delivery.
 */
function sse_response(frames: ReadonlyArray<StreamFrame>): Response {
  const payload = frames
    .map((frame) => `data: ${frame === '[DONE]' ? '[DONE]' : JSON.stringify(frame)}\n\n`)
    .join('')
  const bytes = new TextEncoder().encode(payload)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 9) {
        controller.enqueue(bytes.slice(i, i + 9))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function invoke_streamed(
  frames: ReadonlyArray<StreamFrame>,
  dialect: OpenAICompatibleDialect = make_dialect(),
): Promise<{ result: Awaited<ReturnType<ReturnType<typeof create_openai_compatible_adapter>['invoke_turn']>>; chunks: StreamChunk[]; mock: ReturnType<typeof vi.fn> }> {
  const mock = stub_fetch(sse_response(frames))
  const chunks: StreamChunk[] = []
  const adapter = create_openai_compatible_adapter(dialect)
  const result = await adapter.invoke_turn(
    make_req({
      stream: true,
      tools: [weather_tool],
      dispatch_chunk: async (chunk) => {
        chunks.push(chunk)
      },
    }),
  )
  return { result, chunks, mock }
}

const TEXT_STREAM: StreamFrame[] = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  { choices: [{ index: 0, delta: { content: 'Hello ' } }] },
  { choices: [{ index: 0, delta: { content: 'there' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
  '[DONE]',
]

const TOOL_CALL_STREAM: StreamFrame[] = [
  {
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { index: 0, id: 'call_01', type: 'function', function: { name: 'get_weather', arguments: '' } },
          ],
        },
      },
    ],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Ottawa"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 30, completion_tokens: 18, total_tokens: 48 } },
  '[DONE]',
]

const MIXED_STREAM: StreamFrame[] = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  { choices: [{ index: 0, delta: { content: 'Checking the weather.' } }] },
  {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_02', type: 'function', function: { name: 'get_weather', arguments: '' } },
          ],
        },
      },
    ],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Kingston"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  {
    choices: [],
    usage: {
      prompt_tokens: 140,
      completion_tokens: 32,
      total_tokens: 172,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 7 },
    },
  },
  '[DONE]',
]

describe('streaming invoke_turn', () => {
  it.each([
    ['text', TEXT_FIXTURE, TEXT_STREAM],
    ['tool-call', TOOL_CALL_FIXTURE, TOOL_CALL_STREAM],
    ['mixed', MIXED_FIXTURE, MIXED_STREAM],
  ] as const)('streamed %s result equals the non-streamed result on the shared fixture (C4)', async (_name, fixture, stream) => {
    stub_fetch(json_response(fixture))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const non_streamed = await adapter.invoke_turn(make_req({ tools: [weather_tool] }))
    vi.unstubAllGlobals()
    const { result: streamed } = await invoke_streamed(stream)
    expect(streamed).toEqual(non_streamed)
  })

  it('sends stream and stream_options.include_usage on the wire', async () => {
    const { mock } = await invoke_streamed(TEXT_STREAM)
    const call = mock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toEqual({ include_usage: true })
  })

  it('dispatches loop-ordered chunks with concrete values for the mixed stream', async () => {
    const { chunks } = await invoke_streamed(MIXED_STREAM)
    expect(chunks.map((c) => c.kind)).toEqual([
      'text',
      'tool_call_start',
      'tool_call_input_delta',
      'tool_call_end',
      'step_finish',
    ])
    expect(chunks[0]).toEqual({ kind: 'text', text: 'Checking the weather.', step_index: 0 })
    expect(chunks[1]).toEqual({
      kind: 'tool_call_start',
      id: 'call_02',
      name: 'get_weather',
      step_index: 0,
    })
    expect(chunks[2]).toEqual({
      kind: 'tool_call_input_delta',
      id: 'call_02',
      delta: '{"city":"Kingston"}',
      step_index: 0,
    })
    expect(chunks[3]).toEqual({
      kind: 'tool_call_end',
      id: 'call_02',
      input: { city: 'Kingston' },
      step_index: 0,
    })
    expect(chunks[4]).toEqual({
      kind: 'step_finish',
      step_index: 0,
      finish_reason: 'tool_calls',
      usage: {
        input_tokens: 140,
        output_tokens: 32,
        cached_input_tokens: 100,
        reasoning_tokens: 7,
      },
    })
  })

  it('accumulates interleaved tool_call deltas by index and orders the result by index', async () => {
    const frames: StreamFrame[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } },
                { index: 1, id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"city":"Kingston"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Ottawa"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 8 } },
      '[DONE]',
    ]
    const { result, chunks } = await invoke_streamed(frames)
    expect(result.tool_calls).toEqual([
      { id: 'call_a', name: 'get_weather', input: { city: 'Ottawa' } },
      { id: 'call_b', name: 'get_weather', input: { city: 'Kingston' } },
    ])
    expect(chunks.map((c) => c.kind)).toEqual([
      'tool_call_start',
      'tool_call_start',
      'tool_call_input_delta',
      'tool_call_input_delta',
      'tool_call_end',
      'tool_call_end',
      'step_finish',
    ])
    // Ends dispatch in index order at the finish frame, whatever the delta
    // arrival order was.
    expect(chunks[4]).toMatchObject({ kind: 'tool_call_end', id: 'call_a' })
    expect(chunks[5]).toMatchObject({ kind: 'tool_call_end', id: 'call_b' })
  })

  it('never dispatches empty text chunks for role-only or empty-content deltas', async () => {
    const { chunks } = await invoke_streamed(TEXT_STREAM)
    expect(chunks.filter((c) => c.kind === 'text').map((c) => c.text)).toEqual([
      'Hello ',
      'there',
    ])
  })

  it('zeroes usage without throwing when a tolerant-dialect stream carries none (D10)', async () => {
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, delta: { content: 'hi from local' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]
    const { result, chunks } = await invoke_streamed(
      frames,
      make_dialect({ name: 'lmstudio', auth: { kind: 'none' }, tolerant_usage: true }),
    )
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
    expect(chunks.at(-1)).toEqual({
      kind: 'step_finish',
      step_index: 0,
      finish_reason: 'stop',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  })

  it('throws provider_error when a strict-dialect stream ends without usage', async () => {
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, delta: { content: 'hi' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]
    await expect(invoke_streamed(frames)).rejects.toThrow(/missing its usage/)
  })

  it('throws provider_error when the stream ends before [DONE]', async () => {
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, delta: { content: 'partial' } }] },
    ]
    await expect(invoke_streamed(frames)).rejects.toThrow(/stream ended before \[DONE\]/)
  })

  it('throws provider_error on a frame that is not valid JSON', async () => {
    stub_fetch(
      new Response('data: {"choices": \n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const adapter = create_openai_compatible_adapter(make_dialect())
    await expect(
      adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} })),
    ).rejects.toThrow(/stream frame is not valid JSON/)
  })

  it('throws provider_error when a tool_call delta opens without id and name', async () => {
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
      '[DONE]',
    ]
    await expect(invoke_streamed(frames)).rejects.toThrow(/opened without id and name/)
  })

  it('throws provider_error when a tool_call delta carries no index', async () => {
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_01', function: { name: 'get_weather' } }] } }] },
      '[DONE]',
    ]
    await expect(invoke_streamed(frames)).rejects.toThrow(/missing its index/)
  })

  it('throws provider_error naming the tool when accumulated arguments are not valid JSON', async () => {
    const frames: StreamFrame[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_01', type: 'function', function: { name: 'get_weather', arguments: '{"city": ' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]
    await expect(invoke_streamed(frames)).rejects.toThrow(/get_weather/)
  })

  it('wraps a mid-read transport failure as kind network', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'))
        controller.error(new TypeError('connection reset'))
      },
    })
    stub_fetch(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    )
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter
      .invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
      .catch((e: unknown) => e)
    expect(Reflect.get(err as object, 'kind')).toBe('network')
    expect((err as Error).message).toContain('connection reset')
  })

  it('throws provider_error when the streaming response has no body', async () => {
    stub_fetch(new Response(null, { status: 200 }))
    const adapter = create_openai_compatible_adapter(make_dialect())
    await expect(
      adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} })),
    ).rejects.toThrow(/streaming response has no body/)
  })
})

describe('create_chat_stream_aggregator', () => {
  it('dispatches step_finish once even when [DONE] repeats, and closes tools once', async () => {
    const chunks: StreamChunk[] = []
    const aggregator = create_chat_stream_aggregator(make_dialect(), 2, async (chunk) => {
      chunks.push(chunk)
    })
    await aggregator.handle_data(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_01', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    )
    await aggregator.handle_data(
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    )
    await aggregator.handle_data(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
    )
    await aggregator.handle_data('[DONE]')
    await aggregator.handle_data('[DONE]')
    expect(chunks.map((c) => c.kind)).toEqual([
      'tool_call_start',
      'tool_call_input_delta',
      'tool_call_end',
      'step_finish',
    ])
    expect(chunks.every((c) => 'step_index' in c && c.step_index === 2)).toBe(true)
    expect(aggregator.complete()).toEqual({
      text: '',
      tool_calls: [{ id: 'call_01', name: 'get_weather', input: {} }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 5, output_tokens: 3 },
    })
  })

  it('closes tool calls still open at [DONE] when no finish frame ever arrived', async () => {
    const chunks: StreamChunk[] = []
    const aggregator = create_chat_stream_aggregator(
      make_dialect({ tolerant_usage: true }),
      0,
      async (chunk) => {
        chunks.push(chunk)
      },
    )
    await aggregator.handle_data(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_01', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Ottawa"}' } },
              ],
            },
          },
        ],
      }),
    )
    await aggregator.handle_data('[DONE]')
    expect(chunks.map((c) => c.kind)).toEqual([
      'tool_call_start',
      'tool_call_input_delta',
      'tool_call_end',
      'step_finish',
    ])
    // No finish frame: the parser's default mapping applies.
    expect(aggregator.complete().finish_reason).toBe('stop')
  })
})

// ---------------------------------------------------------------------------
// Mutation hardening. Concrete-value and boundary assertions that pin the
// dialect branches, finish/usage maps, tool-call parsing, error mapping, and
// SSE edges the full-repo Stryker report flagged as survived / no-coverage on
// this file (C7). Behavior is unchanged; these only tighten the assertions.
// ---------------------------------------------------------------------------

function tool_call_payload(entry: unknown): unknown {
  return {
    ...TOOL_CALL_FIXTURE,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [entry] },
        finish_reason: 'tool_calls',
      },
    ],
  }
}

function error_response(
  body: string | null,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers })
}

/** Raw SSE text delivered in 9-byte chunks (mid-line/mid-frame splits). */
function sse_raw(payload: string): Response {
  const bytes = new TextEncoder().encode(payload)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 9) controller.enqueue(bytes.slice(i, i + 9))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** One byte per chunk, so every multibyte UTF-8 sequence straddles a boundary. */
function sse_byte_at_a_time(frames: ReadonlyArray<StreamFrame>): Response {
  const payload = frames
    .map((frame) => `data: ${frame === '[DONE]' ? '[DONE]' : JSON.stringify(frame)}\n\n`)
    .join('')
  const bytes = new TextEncoder().encode(payload)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of bytes) controller.enqueue(new Uint8Array([b]))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('to_chat_messages (mutation hardening)', () => {
  it('names the image_input capability and the ai_sdk transport in the thrown error', () => {
    let caught: unknown
    try {
      to_chat_messages(
        [{ role: 'user', content: [{ type: 'image', image: 'aGk=', media_type: 'image/png' }] }],
        'lmstudio',
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(provider_capability_error)
    expect((caught as provider_capability_error).capability).toBe('image_input')
    expect((caught as Error).message).toContain("transport: 'ai_sdk'")
  })

  it('maps a non-empty plain assistant string verbatim, adding no tool_calls key', () => {
    expect(to_chat_messages([{ role: 'assistant', content: 'all done' }], 'openai')).toEqual([
      { role: 'assistant', content: 'all done' },
    ])
  })

  it('maps a text-only assistant content array to string content with no tool_calls key', () => {
    expect(
      to_chat_messages([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }], 'openai'),
    ).toEqual([{ role: 'assistant', content: 'hi' }])
  })

  it('maps an assistant array that yields empty text to empty-string content, not null', () => {
    expect(
      to_chat_messages([{ role: 'assistant', content: [{ type: 'text', text: '' }] }], 'openai'),
    ).toEqual([{ role: 'assistant', content: '' }])
  })
})

describe('build_chat_completions_body (mutation hardening)', () => {
  it('omits the temperature and top_p keys entirely when they are unset', () => {
    const body = build_chat_completions_body(make_req(), make_dialect())
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
  })

  it('emits only the user message when no system is set', () => {
    const body = build_chat_completions_body(make_req(), make_dialect())
    expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('omits the system message when system is the empty string', () => {
    const body = build_chat_completions_body(make_req({ system: '' }), make_dialect())
    expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('map_chat_usage (mutation hardening)', () => {
  it('does not throw and omits detail keys when the detail containers are null', () => {
    const usage = map_chat_usage(
      {
        prompt_tokens: 5,
        completion_tokens: 3,
        prompt_tokens_details: null,
        completion_tokens_details: null,
      },
      make_dialect(),
    )
    expect(usage).toEqual({ input_tokens: 5, output_tokens: 3 })
    expect(usage).not.toHaveProperty('cached_input_tokens')
    expect(usage).not.toHaveProperty('reasoning_tokens')
  })

  it('omits detail keys when the detail containers carry no counts', () => {
    const usage = map_chat_usage(
      { prompt_tokens: 5, completion_tokens: 3, prompt_tokens_details: {}, completion_tokens_details: {} },
      make_dialect(),
    )
    expect(usage).not.toHaveProperty('cached_input_tokens')
    expect(usage).not.toHaveProperty('reasoning_tokens')
  })
})

describe('parse_chat_completion (mutation hardening)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ] as const)('throws a provider_error for a malformed %s tool_calls entry', (_label, entry) => {
    expect(() => parse_chat_completion(tool_call_payload(entry), make_dialect())).toThrow(provider_error)
    expect(() => parse_chat_completion(tool_call_payload(entry), make_dialect())).toThrow(
      /malformed tool_calls entry/,
    )
  })

  it.each([
    ['a null function', { id: 'call_x', type: 'function', function: null }],
    ['an undefined function', { id: 'call_x', type: 'function' }],
  ] as const)('throws a provider_error for a tool_calls entry with %s', (_label, entry) => {
    expect(() => parse_chat_completion(tool_call_payload(entry), make_dialect())).toThrow(provider_error)
    expect(() => parse_chat_completion(tool_call_payload(entry), make_dialect())).toThrow(
      /malformed tool_calls entry/,
    )
  })

  it('throws a provider_error when a tool_calls entry has a non-string function name', () => {
    const entry = { id: 'call_x', type: 'function', function: { name: 42, arguments: '{}' } }
    expect(() => parse_chat_completion(tool_call_payload(entry), make_dialect())).toThrow(
      /malformed tool_calls entry/,
    )
  })

  it('treats a tool call with no arguments field as an empty input object', () => {
    const entry = { id: 'call_x', type: 'function', function: { name: 'noop' } }
    expect(parse_chat_completion(tool_call_payload(entry), make_dialect()).tool_calls).toEqual([
      { id: 'call_x', name: 'noop', input: {} },
    ])
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
  ] as const)('throws the not-a-JSON-object error for a %s payload', (_label, payload) => {
    expect(() => parse_chat_completion(payload, make_dialect())).toThrow(provider_error)
    expect(() => parse_chat_completion(payload, make_dialect())).toThrow(/payload is not a JSON object/)
  })

  it('throws the no-choices error for a null choice entry', () => {
    expect(() => parse_chat_completion({ ...TEXT_FIXTURE, choices: [null] }, make_dialect())).toThrow(
      /no choices/,
    )
  })

  it('throws the no-choices error for a non-object choice entry', () => {
    expect(() => parse_chat_completion({ ...TEXT_FIXTURE, choices: [5] }, make_dialect())).toThrow(
      /no choices/,
    )
  })

  it('throws the no-message error for a null message', () => {
    expect(() =>
      parse_chat_completion(
        { ...TEXT_FIXTURE, choices: [{ index: 0, message: null, finish_reason: 'stop' }] },
        make_dialect(),
      ),
    ).toThrow(/no message/)
  })
})

describe('create_openai_compatible_adapter error mapping (mutation hardening)', () => {
  it('names the non-empty api_key requirement in the config error', () => {
    expect(() =>
      create_openai_compatible_adapter(make_dialect({ auth: { kind: 'bearer', api_key: '' } })),
    ).toThrow(/non-empty api_key/)
  })

  it('trims every trailing slash from base_url, not just the last one', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_openai_compatible_adapter(
      make_dialect({ base_url: 'https://proxy.local/v1///' }),
    )
    await adapter.invoke_turn(make_req())
    const call = mock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('https://proxy.local/v1/chat/completions')
  })

  it.each([500, 503] as const)(
    'maps a %d error to the retryable plain-Error shape, never a provider_error',
    async (status) => {
      stub_fetch(
        error_response(JSON.stringify({ error: { message: 'overloaded' } }), status, {
          'content-type': 'application/json',
        }),
      )
      const adapter = create_openai_compatible_adapter(make_dialect())
      const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(provider_error)
      const classified = classify_provider_error(err) as Record<string, unknown>
      expect(classified['kind']).toBe('provider_5xx')
      expect(classified['status']).toBe(status)
    },
  )

  it('omits responseHeaders when a retryable status carries no retry-after header', async () => {
    stub_fetch(
      error_response(JSON.stringify({ error: { message: 'overloaded' } }), 500, {
        'content-type': 'application/json',
      }),
    )
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect(Reflect.get(err as object, 'responseHeaders')).toBeUndefined()
  })

  it('reports "(empty body)" as the detail when an error response has an empty body', async () => {
    stub_fetch(error_response('', 500))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect((err as Error).message).toBe('openai API error 500: (empty body)')
  })

  it('truncates a long non-JSON error body to 300 chars plus an ellipsis', async () => {
    stub_fetch(error_response('x'.repeat(400), 500))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect((err as Error).message).toBe(`openai API error 500: ${'x'.repeat(300)}...`)
  })

  it('returns an exactly-300-char body unchanged, without an ellipsis (boundary)', async () => {
    const exact = 'y'.repeat(300)
    stub_fetch(error_response(exact, 500))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect((err as Error).message).toBe(`openai API error 500: ${exact}`)
  })

  it('falls back to "(empty body)" when reading the error body itself fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('body read failed'))
      },
    })
    stub_fetch(new Response(stream, { status: 500, headers: { 'content-type': 'application/json' } }))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect((err as Error).message).toBe('openai API error 500: (empty body)')
  })

  it('returns the raw body, not an empty string, when error.message is empty', async () => {
    const body = JSON.stringify({ error: { message: '' } })
    stub_fetch(error_response(body, 400, { 'content-type': 'application/json' }))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect((err as Error).message).toBe(`openai API error 400: ${body}`)
  })

  it('falls back to the raw body when error.message is not a string', async () => {
    const body = JSON.stringify({ error: { message: ['boom'] } })
    stub_fetch(error_response(body, 400, { 'content-type': 'application/json' }))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect((err as Error).message).toBe(`openai API error 400: ${body}`)
  })
})

describe('streaming invoke_turn (mutation hardening)', () => {
  it('orders tool calls by index regardless of open/arrival order', async () => {
    const frames: StreamFrame[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 2, id: 'call_c', type: 'function', function: { name: 'get_weather', arguments: '{"city":"C"}' } },
                { index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"A"}' } },
                { index: 1, id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '{"city":"B"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      '[DONE]',
    ]
    const { result, chunks } = await invoke_streamed(frames)
    expect(result.tool_calls.map((c) => c.id)).toEqual(['call_a', 'call_b', 'call_c'])
    const ends = chunks
      .filter((c) => c.kind === 'tool_call_end')
      .map((c) => (c as { id: string }).id)
    expect(ends).toEqual(['call_a', 'call_b', 'call_c'])
  })

  it('preserves an early usage frame across later frames that carry none', async () => {
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, delta: { content: 'hi' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]
    const { result } = await invoke_streamed(frames)
    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 2 })
  })

  it.each([
    ['null', null],
    ['a non-object', 5],
  ] as const)(
    'keeps the earlier usage when a later frame carries %s usage',
    async (_label, bad) => {
      const frames: StreamFrame[] = [
        { choices: [{ index: 0, delta: { content: 'hi' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: bad },
        '[DONE]',
      ]
      const { result } = await invoke_streamed(frames)
      expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 2 })
    },
  )

  it('ignores a null choice in a stream frame without aborting the stream', async () => {
    const frames: StreamFrame[] = [
      { choices: [null] },
      { choices: [{ index: 0, delta: { content: 'hello' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      '[DONE]',
    ]
    const { result } = await invoke_streamed(frames)
    expect(result.text).toBe('hello')
  })

  it('ignores a bare null-JSON stream frame without aborting the stream', async () => {
    const head =
      'data: null\n\n' +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
      'data: [DONE]\n\n'
    stub_fetch(sse_raw(head))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const result = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
    expect(result.text).toBe('hello')
  })

  it('ignores a null delta in a stream frame', async () => {
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, delta: null, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      '[DONE]',
    ]
    const { result } = await invoke_streamed(frames)
    expect(result.text).toBe('')
    expect(result.finish_reason).toBe('stop')
  })

  it('ignores a choice that carries no delta field', async () => {
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      '[DONE]',
    ]
    const { result } = await invoke_streamed(frames)
    expect(result.finish_reason).toBe('stop')
  })

  it.each([
    ['a null entry', null],
    ['a non-object entry', 5],
  ] as const)('throws a malformed-delta provider_error for %s in tool_calls', async (_label, entry) => {
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, delta: { tool_calls: [entry] } }] },
      '[DONE]',
    ]
    await expect(invoke_streamed(frames)).rejects.toThrow(/malformed tool_calls delta/)
  })

  it.each([
    ['a null id', { index: 0, id: null, type: 'function', function: { name: 'get_weather', arguments: '' } }],
    ['a null function', { index: 0, id: 'call_x', function: null }],
    ['no function', { index: 0, id: 'call_x' }],
    ['a non-string id', { index: 0, id: 42, type: 'function', function: { name: 'get_weather', arguments: '' } }],
    ['a non-string name', { index: 0, id: 'call_x', type: 'function', function: { name: 42, arguments: '' } }],
  ] as const)('rejects opening a tool_call delta with %s at the opening guard', async (_label, entry) => {
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, delta: { tool_calls: [entry] } }] },
      '[DONE]',
    ]
    await expect(invoke_streamed(frames)).rejects.toThrow(/opened without id and name/)
  })

  it('ignores a null function on a continuation tool_call delta', async () => {
    const frames: StreamFrame[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"city":"A"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: null }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      '[DONE]',
    ]
    const { result } = await invoke_streamed(frames)
    expect(result.tool_calls).toEqual([{ id: 'call_x', name: 'get_weather', input: { city: 'A' } }])
  })

  it('ignores a continuation tool_call delta that carries no function', async () => {
    const frames: StreamFrame[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"city":"A"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0 }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      '[DONE]',
    ]
    const { result } = await invoke_streamed(frames)
    expect(result.tool_calls).toEqual([{ id: 'call_x', name: 'get_weather', input: { city: 'A' } }])
  })

  it('ignores a continuation tool_call delta whose function omits arguments', async () => {
    const frames: StreamFrame[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"city":"A"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: {} }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      '[DONE]',
    ]
    const { result } = await invoke_streamed(frames)
    expect(result.tool_calls).toEqual([{ id: 'call_x', name: 'get_weather', input: { city: 'A' } }])
  })

  it('decodes a multibyte character split across read boundaries (streaming decode)', async () => {
    const content = 'café €'
    const frames: StreamFrame[] = [
      { choices: [{ index: 0, delta: { content } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      '[DONE]',
    ]
    stub_fetch(sse_byte_at_a_time(frames))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const result = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
    expect(result.text).toBe(content)
  })

  it('drains a final frame delivered without a trailing blank line', async () => {
    const head =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
      'data: [DONE]'
    stub_fetch(sse_raw(head))
    const adapter = create_openai_compatible_adapter(make_dialect())
    const result = await adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} }))
    expect(result.text).toBe('hi')
    expect(result.usage).toEqual({ input_tokens: 1, output_tokens: 1 })
  })

  it('cancels the reader when a mid-stream error exits the drain loop early', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {bad\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    stub_fetch(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const adapter = create_openai_compatible_adapter(make_dialect())
    await expect(
      adapter.invoke_turn(make_req({ stream: true, dispatch_chunk: async () => {} })),
    ).rejects.toThrow(/stream frame is not valid JSON/)
    expect(cancelled).toBe(true)
  })
})
