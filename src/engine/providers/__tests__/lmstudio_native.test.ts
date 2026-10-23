/**
 * LM Studio provider, native transport wiring. Proves `transport:
 * 'native'` routes through the shared OpenAI-compatible core with the lmstudio
 * dialect: no auth (no Authorization header), `max_tokens` as the token-limit
 * field, tolerant usage so a local server that omits token counts zeroes
 * them instead of throwing, and `provider_options.lmstudio` wire passthrough
 * merging last on both the stream and non-stream paths. The core's own
 * mapping/parsing is covered by openai_compatible_native.test.ts; here the
 * assertions target the dialect the factory constructs. No live network; fetch
 * is stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderInit, TurnRequest } from '../../types.js'
import { create_lmstudio_adapter } from '../lmstudio.js'
import type { NativeProviderAdapter } from '../types.js'
import { engine_config_error } from '../../errors.js'
import { create_engine } from '../../create_engine.js'

const BASE_URL = 'http://localhost:1234/v1'

function make_req(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    step_index: 0,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    abort: new AbortController().signal,
    stream: false,
    model_id: 'qwen2.5-coder-7b-instruct',
    effort: 'none',
    ...overrides,
  }
}

function stub_fetch(result: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => result)
  vi.stubGlobal('fetch', mock)
  return mock
}

function json_response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const TEXT_FIXTURE = {
  id: 'chatcmpl-local',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
}

// A local server that never reports usage: the tolerant dialect must zero it.
const NO_USAGE_FIXTURE = {
  id: 'chatcmpl-local',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
}

type StreamFrame = Record<string, unknown> | '[DONE]'

function sse_response(frames: ReadonlyArray<StreamFrame>): Response {
  const payload = frames
    .map((frame) => `data: ${frame === '[DONE]' ? '[DONE]' : JSON.stringify(frame)}\n\n`)
    .join('')
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const TEXT_STREAM: StreamFrame[] = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  '[DONE]',
]

function native_adapter(init: Record<string, unknown> = {}): NativeProviderAdapter {
  const adapter = create_lmstudio_adapter({ base_url: BASE_URL, transport: 'native', ...init })
  if (adapter.kind !== 'native') throw new Error('expected the native adapter')
  return adapter
}

/** Run one non-stream turn and return the request the adapter POSTed. */
async function sent_body(
  init: Record<string, unknown>,
  req: Partial<TurnRequest>,
): Promise<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> {
  const mock = stub_fetch(json_response(TEXT_FIXTURE))
  await native_adapter(init).invoke_turn(make_req(req))
  const call = mock.mock.calls[0] as [string, RequestInit]
  return {
    url: call[0],
    headers: call[1].headers as Record<string, string>,
    body: JSON.parse(call[1].body as string) as Record<string, unknown>,
  }
}

/** Run one streamed turn and return the request the adapter POSTed. */
async function streamed_body(
  init: Record<string, unknown>,
  req: Partial<TurnRequest>,
): Promise<Record<string, unknown>> {
  const mock = stub_fetch(sse_response(TEXT_STREAM))
  await native_adapter(init).invoke_turn(
    make_req({ stream: true, dispatch_chunk: async () => {}, ...req }),
  )
  const call = mock.mock.calls[0] as [string, RequestInit]
  return JSON.parse(call[1].body as string) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('transport dispatch', () => {
  it('defaults to the ai_sdk adapter', () => {
    expect(create_lmstudio_adapter({ base_url: BASE_URL }).kind).toBe('ai_sdk')
  })

  it("returns the ai_sdk adapter for transport: 'ai_sdk'", () => {
    expect(create_lmstudio_adapter({ base_url: BASE_URL, transport: 'ai_sdk' }).kind).toBe('ai_sdk')
  })

  it("returns the native adapter for transport: 'native', keeping the provider name", () => {
    const adapter = create_lmstudio_adapter({ base_url: BASE_URL, transport: 'native' })
    expect(adapter.kind).toBe('native')
    expect(adapter.name).toBe('lmstudio')
  })

  it('throws engine_config_error on an unknown transport, naming the provider', () => {
    expect(() => create_lmstudio_adapter({ base_url: BASE_URL, transport: 'grpc' })).toThrow(
      engine_config_error,
    )
    expect(() => create_lmstudio_adapter({ base_url: BASE_URL, transport: 'grpc' })).toThrow(
      /^lmstudio provider: transport must be/,
    )
  })

  it('throws engine_config_error on native with an empty base_url', () => {
    expect(() => create_lmstudio_adapter({ base_url: '', transport: 'native' })).toThrow(
      engine_config_error,
    )
  })

  it('reads a non-string base_url as empty and refuses it, naming the provider', () => {
    let thrown: unknown
    try {
      create_lmstudio_adapter({ base_url: 1234, transport: 'native' } as unknown as ProviderInit)
    } catch (err: unknown) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(engine_config_error)
    expect(thrown).toMatchObject({
      message: 'lmstudio provider requires a non-empty base_url',
      provider: 'lmstudio',
    })
  })
})

describe('lmstudio native dialect wiring', () => {
  it('POSTs to the local chat/completions endpoint with no Authorization header', async () => {
    const { url, headers } = await sent_body({}, {})
    expect(url).toBe('http://localhost:1234/v1/chat/completions')
    expect(headers['content-type']).toBe('application/json')
    expect(headers).not.toHaveProperty('authorization')
  })

  it('respects a base_url override', async () => {
    const { url } = await sent_body({ base_url: 'http://192.168.1.5:1234/v1' }, {})
    expect(url).toBe('http://192.168.1.5:1234/v1/chat/completions')
  })

  it('writes the token limit to max_tokens, not max_completion_tokens', async () => {
    const { body } = await sent_body({}, { max_tokens: 1000 })
    expect(body['max_tokens']).toBe(1000)
    expect(body).not.toHaveProperty('max_completion_tokens')
  })

  it('asks for stream usage via stream_options.include_usage', async () => {
    const body = await streamed_body({}, {})
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toEqual({ include_usage: true })
  })

  it('maps effort to the flat reasoning_effort field (the core does not model-sniff; the server ignores it)', async () => {
    const { body } = await sent_body({}, { effort: 'high' })
    expect(body['reasoning_effort']).toBe('high')
  })

  it.each(['xhigh', 'max'] as const)('clamps effort %s to high, since a local server takes low, medium, and high', async (effort) => {
    const { body } = await sent_body({}, { effort })
    expect(body['reasoning_effort']).toBe('high')
  })
})

describe('tolerant usage', () => {
  it('zeroes usage instead of throwing when the local server omits it', async () => {
    stub_fetch(json_response(NO_USAGE_FIXTURE))
    const result = await native_adapter().invoke_turn(make_req())
    expect(result.text).toBe('ok')
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('reports no cost, even from a usage object that carries one', async () => {
    stub_fetch(json_response({ ...TEXT_FIXTURE, usage: { ...TEXT_FIXTURE.usage, cost: 0.01 } }))
    const result = await native_adapter().invoke_turn(make_req())
    expect('reported_cost_usd' in result).toBe(false)
    expect('provider_reported' in result).toBe(false)
  })
})

describe('provider_options.lmstudio passthrough', () => {
  it('merges wire keys last over derived fields on the non-stream path', async () => {
    const { body } = await sent_body(
      {},
      {
        max_tokens: 1000,
        provider_options: { lmstudio: { max_tokens: 512, response_format: { type: 'json_object' } } },
      },
    )
    // The passthrough token limit beats the engine-derived one.
    expect(body['max_tokens']).toBe(512)
    // A passthrough-only key rides through untouched.
    expect(body['response_format']).toEqual({ type: 'json_object' })
  })

  it('merges wire keys last over derived fields on the stream path', async () => {
    const body = await streamed_body(
      {},
      {
        max_tokens: 1000,
        provider_options: { lmstudio: { max_tokens: 512, top_k: 40 } },
      },
    )
    expect(body['stream']).toBe(true)
    expect(body['max_tokens']).toBe(512)
    expect(body['top_k']).toBe(40)
  })

  it('ignores provider_options keyed to other providers', async () => {
    const { body } = await sent_body({}, { provider_options: { openai: { logprobs: true } } })
    expect(body).not.toHaveProperty('logprobs')
  })
})

describe('lmstudio native through generate', () => {
  it('asks for a stream with no on_chunk and folds it into the result', async () => {
    const mock = stub_fetch(sse_response(TEXT_STREAM))
    const result = await create_engine({
      providers: { lmstudio: { base_url: BASE_URL, transport: 'native' } },
    }).generate({ model: 'local-model', prompt: 'hi' })
    const body = JSON.parse((mock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<
      string,
      unknown
    >
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toStrictEqual({ include_usage: true })
    expect(result.content).toBe('hi')
    // This stream reports no usage, which the tolerant dialect zeroes.
    expect(result.usage).toStrictEqual({ input_tokens: 0, output_tokens: 0 })
    expect(result.steps[0]?.timing?.first_chunk_ms).toBeGreaterThanOrEqual(0)
  })
})

describe('lmstudio native prompt caching', () => {
  it("sends no cache_control for an explicit '5m', and records why", async () => {
    const mock = stub_fetch(sse_response(TEXT_STREAM))
    const events: Array<Record<string, unknown>> = []
    await create_engine({
      providers: { lmstudio: { base_url: BASE_URL, transport: 'native' } },
    }).generate({
      model: 'local-model',
      prompt: 'hi',
      cache: '5m',
      trajectory: {
        record: (event) => events.push(event),
        start_span: () => 'span',
        end_span: () => {},
      },
    })
    const body = JSON.parse((mock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<
      string,
      unknown
    >
    expect(body).not.toHaveProperty('cache_control')
    expect(events.filter((e) => e['kind'] === 'option_ignored')).toStrictEqual([
      {
        kind: 'option_ignored',
        option: 'cache',
        provider: 'lmstudio',
        reason: "this adapter doesn't request prompt caching",
        ts: expect.any(Number),
      },
    ])
  })
})
