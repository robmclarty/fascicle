/**
 * Ollama native adapter (Step 5): the daemon's own /api/chat wire (D2).
 * Covers the request mapping (messages, tools, `options` sampling bag, the
 * always-explicit stream flag, effort ignored, provider_options.ollama
 * passthrough per D9), the NDJSON stream aggregation feeding the one shared
 * parser (streamed equals non-streamed on shared fixtures, C4), done_reason /
 * eval-count mapping with always-tolerant usage (D10), synthesized tool-call
 * ids (this wire has none), and the error ladder the shared classifier
 * expects. No live network; fetch is stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Message, StreamChunk, Tool, TurnRequest } from '../../types.js'
import {
  build_ollama_chat_body,
  create_ndjson_decoder,
  create_ollama_native_adapter,
  map_ollama_finish_reason,
  map_ollama_usage,
  parse_ollama_chat,
  to_ollama_messages,
} from '../ollama_native.js'
import { create_ollama_adapter } from '../ollama.js'
import { classify_provider_error } from '../../generate.js'
import {
  engine_config_error,
  provider_auth_error,
  provider_capability_error,
  provider_error,
} from '../../errors.js'

const BASE_URL = 'http://localhost:11434'

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
    model_id: 'llama3.2',
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
  model: 'llama3.2',
  created_at: '2026-07-11T00:00:00Z',
  message: { role: 'assistant', content: 'Hello there' },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 12,
  eval_count: 6,
}

const TOOL_CALL_FIXTURE = {
  model: 'llama3.2',
  created_at: '2026-07-11T00:00:00Z',
  message: {
    role: 'assistant',
    content: '',
    // The daemon reports done_reason 'stop' on a tool-call turn; the presence
    // of tool_calls is what maps to finish_reason 'tool_calls' (A2).
    tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Ottawa' } } }],
  },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 30,
  eval_count: 18,
}

const MIXED_FIXTURE = {
  model: 'llama3.2',
  created_at: '2026-07-11T00:00:00Z',
  message: {
    role: 'assistant',
    content: 'Checking the weather.',
    tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Kingston' } } }],
  },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 140,
  eval_count: 32,
}

const TEXT_STREAM: Array<Record<string, unknown>> = [
  { model: 'llama3.2', message: { role: 'assistant', content: 'Hello ' }, done: false },
  { model: 'llama3.2', message: { role: 'assistant', content: 'there' }, done: false },
  {
    model: 'llama3.2',
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 12,
    eval_count: 6,
  },
]

const TOOL_CALL_STREAM: Array<Record<string, unknown>> = [
  {
    model: 'llama3.2',
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Ottawa' } } }],
    },
    done: false,
  },
  {
    model: 'llama3.2',
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 30,
    eval_count: 18,
  },
]

const MIXED_STREAM: Array<Record<string, unknown>> = [
  { model: 'llama3.2', message: { role: 'assistant', content: 'Checking ' }, done: false },
  { model: 'llama3.2', message: { role: 'assistant', content: 'the weather.' }, done: false },
  {
    model: 'llama3.2',
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Kingston' } } }],
    },
    done: false,
  },
  {
    model: 'llama3.2',
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 140,
    eval_count: 32,
  },
]

/**
 * Encode frames as NDJSON lines and chunk the bytes at awkward boundaries so
 * the incremental decode path (mid-line, mid-frame splits) is exercised, not
 * just whole-line delivery.
 */
function ndjson_response(
  frames: ReadonlyArray<Record<string, unknown>>,
  { trailing_newline = true } = {},
): Response {
  const payload =
    frames.map((frame) => JSON.stringify(frame)).join('\n') + (trailing_newline ? '\n' : '')
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
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

async function invoke_streamed(frames: ReadonlyArray<Record<string, unknown>>, response?: Response): Promise<{
  result: Awaited<ReturnType<ReturnType<typeof create_ollama_native_adapter>['invoke_turn']>>
  chunks: StreamChunk[]
  mock: ReturnType<typeof vi.fn>
}> {
  const mock = stub_fetch(response ?? ndjson_response(frames))
  const chunks: StreamChunk[] = []
  const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
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

describe('transport dispatch', () => {
  it('defaults to the ai_sdk adapter', () => {
    expect(create_ollama_adapter({ base_url: BASE_URL }).kind).toBe('ai_sdk')
  })

  it("returns the ai_sdk adapter for transport: 'ai_sdk'", () => {
    expect(create_ollama_adapter({ base_url: BASE_URL, transport: 'ai_sdk' }).kind).toBe('ai_sdk')
  })

  it("returns the native adapter for transport: 'native', keeping the provider name", () => {
    const adapter = create_ollama_adapter({ base_url: BASE_URL, transport: 'native' })
    expect(adapter.kind).toBe('native')
    expect(adapter.name).toBe('ollama')
  })

  it('throws engine_config_error on an unknown transport', () => {
    expect(() => create_ollama_adapter({ base_url: BASE_URL, transport: 'grpc' })).toThrow(
      engine_config_error,
    )
  })

  it('throws engine_config_error on native with an empty base_url', () => {
    expect(() => create_ollama_adapter({ base_url: '', transport: 'native' })).toThrow(
      engine_config_error,
    )
  })

  it('claims text, tools, schema, and streaming; not structured_output, reasoning, or image_input', () => {
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    for (const cap of ['text', 'tools', 'schema', 'streaming'] as const) {
      expect(adapter.supports(cap)).toBe(true)
    }
    for (const cap of ['structured_output', 'reasoning', 'image_input'] as const) {
      expect(adapter.supports(cap)).toBe(false)
    }
  })
})

describe('to_ollama_messages', () => {
  it('maps system messages in place (no top-level system field on this wire)', () => {
    const messages: Message[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]
    expect(to_ollama_messages(messages)).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('flattens user content parts to one newline-joined string, dropping empty parts', () => {
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
    expect(to_ollama_messages(messages)).toEqual([{ role: 'user', content: 'first\nsecond' }])
  })

  it('throws provider_capability_error on image parts', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'image', image: 'aGk=', media_type: 'image/png' }] },
    ]
    expect(() => to_ollama_messages(messages)).toThrow(provider_capability_error)
  })

  it('maps assistant tool_call parts to object-valued arguments with no id on the wire', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool_call', id: 'ollama_call_0_0', name: 'get_weather', input: { city: 'Ottawa' } },
        ],
      },
    ]
    expect(to_ollama_messages(messages)).toEqual([
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Ottawa' } } }],
      },
    ])
  })

  it('maps tool results to tool role messages keyed by tool_name, not a call id', () => {
    const messages: Message[] = [
      { role: 'tool', tool_call_id: 'ollama_call_0_0', name: 'get_weather', content: 'sunny' },
    ]
    expect(to_ollama_messages(messages)).toEqual([
      { role: 'tool', tool_name: 'get_weather', content: 'sunny' },
    ])
  })
})

describe('build_ollama_chat_body', () => {
  it('prepends TurnRequest.system and sends stream: false explicitly (the endpoint defaults to streaming)', () => {
    const body = build_ollama_chat_body(make_req({ system: 'be terse' }))
    expect(body).toEqual({
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      stream: false,
    })
  })

  it('sends stream: true on the streaming path', () => {
    const body = build_ollama_chat_body(make_req({ stream: true }))
    expect(body['stream']).toBe(true)
  })

  it('maps tools to the OpenAI function shape with a JSON-schema parameters object', () => {
    const body = build_ollama_chat_body(make_req({ tools: [weather_tool] }))
    const tools = body['tools'] as Array<Record<string, unknown>>
    expect(tools).toHaveLength(1)
    expect(tools[0]?.['type']).toBe('function')
    const fn = tools[0]?.['function'] as Record<string, unknown>
    expect(fn['name']).toBe('get_weather')
    expect(fn['description']).toBe('Look up current weather for a city')
    const parameters = fn['parameters'] as Record<string, unknown>
    expect(parameters['type']).toBe('object')
    expect(Reflect.get(parameters['properties'] as object, 'city')).toEqual({ type: 'string' })
  })

  it('routes sampling params into the options bag as num_predict / temperature / top_p', () => {
    const body = build_ollama_chat_body(
      make_req({ max_tokens: 256, temperature: 0.2, top_p: 0.9 }),
    )
    expect(body['options']).toEqual({ num_predict: 256, temperature: 0.2, top_p: 0.9 })
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('num_predict')
  })

  it('omits the options bag entirely when no sampling params are set', () => {
    expect(build_ollama_chat_body(make_req())).not.toHaveProperty('options')
  })

  it('ignores effort entirely: no reasoning or think field at any level (D2)', () => {
    const body = build_ollama_chat_body(make_req({ effort: 'high' }))
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('think')
    expect(body).not.toHaveProperty('options')
  })
})

describe('provider_options.ollama passthrough (D9)', () => {
  it('rides think and keep_alive through untouched', () => {
    const body = build_ollama_chat_body(
      make_req({ provider_options: { ollama: { think: true, keep_alive: '10m' } } }),
    )
    expect(body['think']).toBe(true)
    expect(body['keep_alive']).toBe('10m')
  })

  it('replaces the engine-derived options bag wholesale (shallow merge)', () => {
    const body = build_ollama_chat_body(
      make_req({
        max_tokens: 256,
        provider_options: { ollama: { options: { num_ctx: 8192 } } },
      }),
    )
    expect(body['options']).toEqual({ num_ctx: 8192 })
  })

  it('ignores provider_options keyed to other providers', () => {
    const body = build_ollama_chat_body(
      make_req({ provider_options: { openai: { logprobs: true } } }),
    )
    expect(body).not.toHaveProperty('logprobs')
  })

  it('merges wire keys last on the stream path too', async () => {
    const mock = stub_fetch(ndjson_response(TEXT_STREAM))
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    await adapter.invoke_turn(
      make_req({
        stream: true,
        dispatch_chunk: async () => {},
        provider_options: { ollama: { think: true } },
      }),
    )
    const call = mock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>
    expect(body['stream']).toBe(true)
    expect(body['think']).toBe(true)
  })
})

describe('map_ollama_finish_reason', () => {
  it('lets the presence of tool calls win over done_reason (A2)', () => {
    expect(map_ollama_finish_reason('stop', true)).toBe('tool_calls')
  })

  it('maps length to length', () => {
    expect(map_ollama_finish_reason('length', false)).toBe('length')
  })

  it('maps stop, unknown values, and absent to stop', () => {
    expect(map_ollama_finish_reason('stop', false)).toBe('stop')
    expect(map_ollama_finish_reason('load', false)).toBe('stop')
    expect(map_ollama_finish_reason(undefined, false)).toBe('stop')
  })
})

describe('map_ollama_usage (D10)', () => {
  it('maps prompt_eval_count / eval_count to input / output tokens', () => {
    expect(map_ollama_usage({ prompt_eval_count: 12, eval_count: 6 })).toEqual({
      input_tokens: 12,
      output_tokens: 6,
    })
  })

  it('zeroes absent counts instead of throwing', () => {
    expect(map_ollama_usage({ done: true })).toEqual({ input_tokens: 0, output_tokens: 0 })
    expect(map_ollama_usage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 })
  })
})

describe('parse_ollama_chat', () => {
  it('parses a text response with concrete values', () => {
    expect(parse_ollama_chat(TEXT_FIXTURE, 0)).toEqual({
      text: 'Hello there',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 12, output_tokens: 6 },
    })
  })

  it('synthesizes step-scoped ordinal tool-call ids (this wire sends none)', () => {
    expect(parse_ollama_chat(TOOL_CALL_FIXTURE, 2)).toEqual({
      text: '',
      tool_calls: [{ id: 'ollama_call_2_0', name: 'get_weather', input: { city: 'Ottawa' } }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 30, output_tokens: 18 },
    })
  })

  it('prefers a wire id when the daemon sends one', () => {
    const payload = {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_native', function: { name: 'get_weather', arguments: { city: 'Ottawa' } } },
        ],
      },
      done: true,
      done_reason: 'stop',
    }
    expect(parse_ollama_chat(payload, 0).tool_calls[0]?.id).toBe('call_native')
  })

  it('tolerates compat-shaped string arguments, treating the empty string as {}', () => {
    const payload = {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'get_weather', arguments: '{"city":"Ottawa"}' } },
          { function: { name: 'get_weather', arguments: '' } },
        ],
      },
      done: true,
    }
    const result = parse_ollama_chat(payload, 0)
    expect(result.tool_calls).toEqual([
      { id: 'ollama_call_0_0', name: 'get_weather', input: { city: 'Ottawa' } },
      { id: 'ollama_call_0_1', name: 'get_weather', input: {} },
    ])
  })

  it('throws a provider_error naming the tool on invalid JSON string arguments', () => {
    const payload = {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'get_weather', arguments: '{broken' } }],
      },
      done: true,
    }
    let err: unknown
    try {
      parse_ollama_chat(payload, 0)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe(
      'ollama native: tool_calls arguments for get_weather is not valid JSON',
    )
  })

  it('throws provider_error on a malformed tool_calls entry', () => {
    for (const entry of [null, {}, { function: { arguments: {} } }]) {
      const payload = { message: { role: 'assistant', content: '', tool_calls: [entry] }, done: true }
      expect(() => parse_ollama_chat(payload, 0)).toThrow(provider_error)
    }
  })

  it('throws provider_error when the payload is not an object or has no message', () => {
    expect(() => parse_ollama_chat('nope', 0)).toThrow(provider_error)
    expect(() => parse_ollama_chat({ done: true }, 0)).toThrow(provider_error)
  })
})

describe('create_ndjson_decoder', () => {
  it('reassembles lines split at arbitrary boundaries, dropping blank lines', () => {
    const decoder = create_ndjson_decoder()
    expect(decoder.push('{"a"')).toEqual([])
    expect(decoder.push(':1}\n\n{"b"')).toEqual(['{"a":1}'])
    expect(decoder.push(':2}\r\n')).toEqual(['{"b":2}'])
    expect(decoder.flush()).toEqual([])
  })

  it('drains a final line left open when the stream ends without a newline', () => {
    const decoder = create_ndjson_decoder()
    expect(decoder.push('{"a":1}')).toEqual([])
    expect(decoder.flush()).toEqual(['{"a":1}'])
    expect(decoder.flush()).toEqual([])
  })
})

describe('create_ollama_native_adapter', () => {
  it('POSTs the mapped body to /api/chat off the daemon root with no auth header', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_ollama_native_adapter({ base_url: `${BASE_URL}/` })
    const result = await adapter.invoke_turn(make_req({ system: 'be terse' }))

    expect(mock).toHaveBeenCalledTimes(1)
    const call = mock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('http://localhost:11434/api/chat')
    expect(call[1].method).toBe('POST')
    const headers = call[1].headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers).not.toHaveProperty('authorization')
    expect(JSON.parse(call[1].body as string)).toEqual({
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      stream: false,
    })
    expect(result.text).toBe('Hello there')
  })

  it('returns the parsed TurnResult for a tool-call fixture end to end', async () => {
    stub_fetch(json_response(TOOL_CALL_FIXTURE))
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    const result = await adapter.invoke_turn(make_req({ tools: [weather_tool] }))
    expect(result).toEqual({
      text: '',
      tool_calls: [{ id: 'ollama_call_0_0', name: 'get_weather', input: { city: 'Ottawa' } }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 30, output_tokens: 18 },
    })
  })

  it('throws provider_auth_error on 401 with the API error message', async () => {
    stub_fetch(json_response({ error: 'unauthorized' }, 401))
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_auth_error)
    expect((err as provider_auth_error).provider).toBe('ollama')
    expect((err as Error).message).toBe('ollama authentication failed (401): unauthorized')
  })

  it('throws a 429 shape the shared classifier maps to rate_limit with retry_after_ms', async () => {
    stub_fetch(json_response({ error: 'busy' }, 429, { 'retry-after': '2' }))
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    const classified = classify_provider_error(err) as Record<string, unknown>
    expect(classified['kind']).toBe('rate_limit')
    expect(classified['status']).toBe(429)
    expect(classified['retry_after_ms']).toBe(2000)
    expect(classified['message']).toBe('ollama API error 429: busy')
  })

  it('throws a 5xx shape the shared classifier maps to provider_5xx', async () => {
    stub_fetch(json_response({ error: 'model runner has unexpectedly stopped' }, 500))
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    const classified = classify_provider_error(err) as Record<string, unknown>
    expect(classified['kind']).toBe('provider_5xx')
    expect(classified['status']).toBe(500)
    expect(classified['message']).toBe('ollama API error 500: model runner has unexpectedly stopped')
  })

  it("throws a permanent provider_error on other 4xx, reading Ollama's string error body", async () => {
    stub_fetch(json_response({ error: "model 'nope' not found" }, 404))
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).status).toBe(404)
    expect((err as Error).message).toBe("ollama API error 404: model 'nope' not found")
    expect(classify_provider_error(err)).toBe(err)
  })

  it('falls back to the raw body when the error payload is not JSON', async () => {
    stub_fetch(new Response('daemon exploded', { status: 400 }))
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect((err as Error).message).toBe('ollama API error 400: daemon exploded')
  })

  it('wraps transport failures as kind network for the shared classifier', async () => {
    stub_fetch(new TypeError('fetch failed'))
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    const err: unknown = await adapter.invoke_turn(make_req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(Reflect.get(err as object, 'kind')).toBe('network')
    expect((err as Error).message).toBe('ollama native: network failure: fetch failed')
    expect(classify_provider_error(err)).toBe(err)
  })

  it('rethrows the fetch abort error untouched when the signal aborted', async () => {
    const abort_err = new DOMException('This operation was aborted', 'AbortError')
    stub_fetch(abort_err)
    const controller = new AbortController()
    controller.abort()
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    await expect(adapter.invoke_turn(make_req({ abort: controller.signal }))).rejects.toBe(
      abort_err,
    )
  })
})

describe('streaming invoke_turn', () => {
  it.each([
    ['text', TEXT_FIXTURE, TEXT_STREAM],
    ['tool-call', TOOL_CALL_FIXTURE, TOOL_CALL_STREAM],
    ['mixed', MIXED_FIXTURE, MIXED_STREAM],
  ] as const)('streamed %s result equals the non-streamed result on the shared fixture (C4)', async (_name, fixture, stream) => {
    stub_fetch(json_response(fixture))
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    const non_streamed = await adapter.invoke_turn(make_req({ tools: [weather_tool] }))
    vi.unstubAllGlobals()
    const { result: streamed } = await invoke_streamed(stream)
    expect(streamed).toEqual(non_streamed)
  })

  it('dispatches loop-ordered chunks for the mixed stream: whole tool calls, no input deltas', async () => {
    const { chunks } = await invoke_streamed(MIXED_STREAM)
    expect(chunks.map((c) => c.kind)).toEqual([
      'text',
      'text',
      'tool_call_start',
      'tool_call_end',
      'step_finish',
    ])
    expect(chunks[0]).toEqual({ kind: 'text', text: 'Checking ', step_index: 0 })
    expect(chunks[1]).toEqual({ kind: 'text', text: 'the weather.', step_index: 0 })
    expect(chunks[2]).toEqual({
      kind: 'tool_call_start',
      id: 'ollama_call_0_0',
      name: 'get_weather',
      step_index: 0,
    })
    expect(chunks[3]).toEqual({
      kind: 'tool_call_end',
      id: 'ollama_call_0_0',
      input: { city: 'Kingston' },
      step_index: 0,
    })
    expect(chunks[4]).toEqual({
      kind: 'step_finish',
      step_index: 0,
      finish_reason: 'tool_calls',
      usage: { input_tokens: 140, output_tokens: 32 },
    })
  })

  it('gives calls across frames sequential ordinals matching the non-stream parse', async () => {
    const frames: Array<Record<string, unknown>> = [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Ottawa' } } }],
        },
        done: false,
      },
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Kingston' } } }],
        },
        done: false,
      },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
    ]
    const { result } = await invoke_streamed(frames)
    expect(result.tool_calls).toEqual([
      { id: 'ollama_call_0_0', name: 'get_weather', input: { city: 'Ottawa' } },
      { id: 'ollama_call_0_1', name: 'get_weather', input: { city: 'Kingston' } },
    ])
    expect(result.finish_reason).toBe('tool_calls')
  })

  it('completes through the flush path when the stream lacks a trailing newline', async () => {
    const { result } = await invoke_streamed(
      TEXT_STREAM,
      ndjson_response(TEXT_STREAM, { trailing_newline: false }),
    )
    expect(result.text).toBe('Hello there')
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 6 })
  })

  it('ignores frames after the done frame instead of double-finishing', async () => {
    const frames = [...TEXT_STREAM, { message: { role: 'assistant', content: 'late' }, done: false }]
    const { result, chunks } = await invoke_streamed(frames)
    expect(result.text).toBe('Hello there')
    expect(chunks.filter((c) => c.kind === 'step_finish')).toHaveLength(1)
  })

  it('fails loud when the stream ends before its done frame (truncated output)', async () => {
    const err: unknown = await invoke_streamed(TEXT_STREAM.slice(0, 2)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe(
      'ollama native: stream ended before its done frame; the result would be truncated',
    )
  })

  it('throws provider_error on a frame that is not valid JSON', async () => {
    const bytes = new TextEncoder().encode('{"message":{"content":"hi"},"done":false}\nnot json\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    const response = new Response(stream, { status: 200 })
    const err: unknown = await invoke_streamed([], response).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe('ollama native: stream frame is not valid JSON')
  })
})

// ---------------------------------------------------------------------------
// Mutation hardening. Concrete-value and boundary assertions that pin the
// request mapping, the NDJSON stream-drain / error-classification region
// (~394-478), the done_reason / eval-count maps, and the tool-call parse paths
// the full-repo Stryker report flagged as survived / no-coverage on this file
// (C7). Behavior is unchanged; these only tighten the assertions.
// ---------------------------------------------------------------------------

function raw_stream_response(text: string, status = 200): Response {
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'application/x-ndjson' } })
}

function per_byte_stream_response(text: string): Response {
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

describe('to_ollama_messages (mutation hardening)', () => {
  it('names the provider, capability, and detail in the image_input error', () => {
    let caught: unknown
    try {
      to_ollama_messages([
        { role: 'user', content: [{ type: 'image', image: 'aGk=', media_type: 'image/png' }] },
      ])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(provider_capability_error)
    expect((caught as provider_capability_error).provider).toBe('ollama')
    expect((caught as provider_capability_error).capability).toBe('image_input')
    expect((caught as Error).message).toBe(
      "provider 'ollama' does not support 'image_input': image parts are not mapped on the native transport; use transport: 'ai_sdk'",
    )
  })

  it('maps a plain assistant string verbatim, adding no tool_calls key', () => {
    expect(to_ollama_messages([{ role: 'assistant', content: 'plain reply' }])).toEqual([
      { role: 'assistant', content: 'plain reply' },
    ])
  })

  it('concatenates assistant text parts with no separator and adds no tool_calls key', () => {
    expect(
      to_ollama_messages([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'foo' },
            { type: 'text', text: 'bar' },
          ],
        },
      ]),
    ).toEqual([{ role: 'assistant', content: 'foobar' }])
  })
})

describe('build_ollama_chat_body (mutation hardening)', () => {
  it('emits only the user message when no system is set', () => {
    expect(build_ollama_chat_body(make_req())['messages']).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('omits the system message when system is the empty string', () => {
    expect(build_ollama_chat_body(make_req({ system: '' }))['messages']).toEqual([
      { role: 'user', content: 'hi' },
    ])
  })
})

describe('map_ollama_usage (mutation hardening)', () => {
  it('zeroes a null payload instead of throwing (the === null guard branch)', () => {
    expect(map_ollama_usage(null)).toEqual({ input_tokens: 0, output_tokens: 0 })
  })
})

function tool_call_error(entry: unknown): unknown {
  try {
    parse_ollama_chat(
      { message: { role: 'assistant', content: '', tool_calls: [entry] }, done: true },
      0,
    )
    return undefined
  } catch (e) {
    return e
  }
}

describe('parse_ollama_chat (mutation hardening)', () => {
  it('throws the malformed-entry provider_error naming the message for a primitive entry', () => {
    const err = tool_call_error('not an object')
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe('ollama native: malformed tool_calls entry in response')
  })

  it('throws the malformed-entry provider_error for a null function', () => {
    const err = tool_call_error({ function: null })
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe('ollama native: malformed tool_calls entry in response')
  })

  it('throws the malformed-entry provider_error for a non-string function name', () => {
    const err = tool_call_error({ function: { arguments: {} } })
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe('ollama native: malformed tool_calls entry in response')
  })

  it('synthesizes an id when the wire id is the empty string (the length > 0 boundary)', () => {
    const result = parse_ollama_chat(
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: '', function: { name: 'get_weather', arguments: { city: 'Ottawa' } } }],
        },
        done: true,
      },
      0,
    )
    expect(result.tool_calls[0]?.id).toBe('ollama_call_0_0')
  })

  it('keeps object-shaped arguments verbatim rather than JSON-parsing them (the string guard)', () => {
    const result = parse_ollama_chat(
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: ['a'] } }],
        },
        done: true,
      },
      0,
    )
    expect(result.tool_calls[0]?.input).toEqual(['a'])
  })

  it('defaults null arguments to an empty object (the !== null guard)', () => {
    const result = parse_ollama_chat(
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: null } }],
        },
        done: true,
      },
      0,
    )
    expect(result.tool_calls[0]?.input).toEqual({})
  })

  it('throws the payload provider_error naming the message for a null payload', () => {
    let err: unknown
    try {
      parse_ollama_chat(null, 0)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe('ollama native: response payload is not a JSON object')
  })

  it('throws the no-message provider_error for a null message', () => {
    let err: unknown
    try {
      parse_ollama_chat({ message: null, done: true }, 0)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe('ollama native: response has no message')
  })

  it('throws the no-message provider_error for a non-object message', () => {
    expect(() => parse_ollama_chat({ message: 'nope', done: true }, 0)).toThrow(provider_error)
  })

  it('returns empty text when content is absent (the string ternary else branch)', () => {
    expect(
      parse_ollama_chat(
        {
          message: {
            role: 'assistant',
            tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'X' } } }],
          },
          done: true,
        },
        0,
      ).text,
    ).toBe('')
  })

  it('reads done_reason (not another key) to map length', () => {
    expect(
      parse_ollama_chat({ message: { content: 'x' }, done: true, done_reason: 'length' }, 0)
        .finish_reason,
    ).toBe('length')
  })
})

describe('create_ndjson_decoder (mutation hardening)', () => {
  it('drops a whitespace-only line (trim, not raw length)', () => {
    expect(create_ndjson_decoder().push('   \n')).toEqual([])
  })
})

describe('streaming invoke_turn (mutation hardening)', () => {
  it('processes a content-less tool-call frame without dereferencing absent content', async () => {
    const { result } = await invoke_streamed([
      {
        message: {
          role: 'assistant',
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Ottawa' } } }],
        },
        done: false,
      },
      {
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 1,
        eval_count: 1,
      },
    ])
    expect(result.text).toBe('')
    expect(result.tool_calls).toEqual([
      { id: 'ollama_call_0_0', name: 'get_weather', input: { city: 'Ottawa' } },
    ])
  })

  it('ignores a bare null-JSON frame without aborting the stream', async () => {
    const { result } = await invoke_streamed(
      [],
      raw_stream_response(
        '{"message":{"content":"Hi"},"done":false}\nnull\n{"message":{"content":""},"done":true,"done_reason":"stop"}\n',
      ),
    )
    expect(result.text).toBe('Hi')
  })

  it('ignores a non-object (number) frame without aborting the stream', async () => {
    const { result } = await invoke_streamed(
      [],
      raw_stream_response(
        '{"message":{"content":"Hi"},"done":false}\n42\n{"message":{"content":""},"done":true,"done_reason":"stop"}\n',
      ),
    )
    expect(result.text).toBe('Hi')
  })

  it('skips a null message on a frame without dereferencing it', async () => {
    const { result } = await invoke_streamed(
      [],
      raw_stream_response(
        '{"message":null,"done":false}\n{"message":{"content":"Hi"},"done":true,"done_reason":"stop"}\n',
      ),
    )
    expect(result.text).toBe('Hi')
  })

  it('skips a non-object message on a frame without dereferencing it', async () => {
    const { result } = await invoke_streamed(
      [],
      raw_stream_response(
        '{"message":"hi","done":false}\n{"message":{"content":"Hi"},"done":true,"done_reason":"stop"}\n',
      ),
    )
    expect(result.text).toBe('Hi')
  })

  it('reads done_reason on the done frame to map length end to end', async () => {
    const { result, chunks } = await invoke_streamed([
      { message: { role: 'assistant', content: 'Hi' }, done: false },
      {
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'length',
        prompt_eval_count: 2,
        eval_count: 3,
      },
    ])
    expect(result.finish_reason).toBe('length')
    const finish = chunks.find((c) => c.kind === 'step_finish')
    expect(finish).toMatchObject({ finish_reason: 'length' })
  })

  it('dispatches a step_finish of stop (not tool_calls) for a text-only stream', async () => {
    const { chunks } = await invoke_streamed(TEXT_STREAM)
    const finish = chunks.find((c) => c.kind === 'step_finish')
    expect(finish).toMatchObject({ finish_reason: 'stop' })
  })

  it('throws a provider_error when a streaming response has no body', async () => {
    const err: unknown = await invoke_streamed([], new Response(null, { status: 200 })).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(provider_error)
    expect((err as Error).message).toBe('ollama native: streaming response has no body')
  })

  it('wraps a mid-stream reader failure as a network error the classifier retries', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('reader boom'))
      },
    })
    const err: unknown = await invoke_streamed([], new Response(stream, { status: 200 })).catch(
      (e: unknown) => e,
    )
    expect(Reflect.get(err as object, 'kind')).toBe('network')
    expect((err as Error).message).toBe('ollama native: network failure: reader boom')
    expect(classify_provider_error(err)).toBe(err)
  })

  it('decodes a multibyte character split across read boundaries (streaming decode)', async () => {
    const content = 'café ☕ complete'
    const { result } = await invoke_streamed(
      [],
      per_byte_stream_response(
        `${JSON.stringify({ message: { content }, done: true, done_reason: 'stop' })}\n`,
      ),
    )
    expect(result.text).toBe(content)
  })

  it('cancels the reader in the finally, even on a fully drained stream', async () => {
    const base = ndjson_response(TEXT_STREAM)
    const body = base.body as ReadableStream<Uint8Array>
    const real_get_reader = body.getReader.bind(body)
    let cancelled = false
    Object.defineProperty(body, 'getReader', {
      value: () => {
        const reader = real_get_reader()
        const real_cancel = reader.cancel.bind(reader)
        reader.cancel = async (reason?: unknown): Promise<void> => {
          cancelled = true
          return real_cancel(reason)
        }
        return reader
      },
    })
    const { result } = await invoke_streamed(TEXT_STREAM, base)
    expect(result.text).toBe('Hello there')
    expect(cancelled).toBe(true)
  })
})

describe('response error mapping (mutation hardening)', () => {
  async function invoke_error(response: Response): Promise<unknown> {
    stub_fetch(response)
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    return adapter.invoke_turn(make_req()).catch((e: unknown) => e)
  }

  it('reports "(empty body)" when the error response body is empty', async () => {
    const err = await invoke_error(new Response('', { status: 400 }))
    expect((err as Error).message).toBe('ollama API error 400: (empty body)')
  })

  it('reads the nested OpenAI-shaped error.message', async () => {
    const err = await invoke_error(json_response({ error: { message: 'nested detail' } }, 400))
    expect((err as Error).message).toBe('ollama API error 400: nested detail')
  })

  it('falls back to the raw body when the nested error.message is empty', async () => {
    const err = await invoke_error(json_response({ error: { message: '' } }, 400))
    expect((err as Error).message).toBe('ollama API error 400: {"error":{"message":""}}')
  })

  it('falls back to the raw body when the top-level error string is empty', async () => {
    const err = await invoke_error(json_response({ error: '' }, 400))
    expect((err as Error).message).toBe('ollama API error 400: {"error":""}')
  })

  it('does not treat a non-string error value as the detail (typeof string guard)', async () => {
    const err = await invoke_error(json_response({ error: ['boom'] }, 400))
    expect((err as Error).message).toBe('ollama API error 400: {"error":["boom"]}')
  })

  it('does not treat a non-string nested message as the detail (typeof string guard)', async () => {
    const err = await invoke_error(json_response({ error: { message: ['y'] } }, 400))
    expect((err as Error).message).toBe('ollama API error 400: {"error":{"message":["y"]}}')
  })

  it('truncates a long non-JSON body to 300 chars plus an ellipsis', async () => {
    const err = await invoke_error(new Response('x'.repeat(400), { status: 400 }))
    expect((err as Error).message).toBe(`ollama API error 400: ${'x'.repeat(300)}...`)
  })

  it('returns an exactly-300-char body unchanged, without an ellipsis (boundary)', async () => {
    const exact = 'y'.repeat(300)
    const err = await invoke_error(new Response(exact, { status: 400 }))
    expect((err as Error).message).toBe(`ollama API error 400: ${exact}`)
  })

  it('falls back to "(empty body)" when reading the error body itself fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('body boom'))
      },
    })
    const err = await invoke_error(new Response(stream, { status: 400 }))
    expect((err as Error).message).toBe('ollama API error 400: (empty body)')
  })

  it('maps a 5xx to a retryable plain Error, not a permanent provider_error', async () => {
    const err = await invoke_error(json_response({ error: 'overloaded' }, 500))
    expect(err).not.toBeInstanceOf(provider_error)
    const classified = classify_provider_error(err) as Record<string, unknown>
    expect(classified['kind']).toBe('provider_5xx')
  })

  it('omits responseHeaders when a 5xx carries no retry-after header', async () => {
    const err = await invoke_error(json_response({ error: 'overloaded' }, 500))
    expect(Reflect.get(err as object, 'responseHeaders')).toBeUndefined()
  })
})

describe('create_ollama_native_adapter setup (mutation hardening)', () => {
  it('throws a named engine_config_error when base_url is not a string', () => {
    let err: unknown
    try {
      create_ollama_native_adapter({ base_url: 42 as unknown as string })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(engine_config_error)
    expect((err as Error).message).toBe('ollama provider requires a non-empty base_url')
    expect((err as engine_config_error).provider).toBe('ollama')
  })

  it('trims every trailing slash from base_url, not just the last one', async () => {
    const mock = stub_fetch(json_response(TEXT_FIXTURE))
    const adapter = create_ollama_native_adapter({ base_url: `${BASE_URL}///` })
    await adapter.invoke_turn(make_req())
    const call = mock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('http://localhost:11434/api/chat')
  })

  it('ignores dispatch_chunk on a non-stream request (never enters the NDJSON path)', async () => {
    stub_fetch(json_response(TEXT_FIXTURE))
    const chunks: StreamChunk[] = []
    const adapter = create_ollama_native_adapter({ base_url: BASE_URL })
    const result = await adapter.invoke_turn(
      make_req({
        stream: false,
        dispatch_chunk: async (chunk) => {
          chunks.push(chunk)
        },
      }),
    )
    expect(chunks).toEqual([])
    expect(result.text).toBe('Hello there')
  })
})
