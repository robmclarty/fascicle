/**
 * OpenRouter provider, native transport wiring (Step 4). Proves `transport:
 * 'native'` routes through the shared OpenAI-compatible core with the openrouter
 * dialect: Bearer auth, the optional `HTTP-Referer`/`X-Title` attribution
 * headers, `max_tokens` as the token-limit field (not `max_completion_tokens`),
 * `reasoning_effort` per Appendix A4, and `provider_options.openrouter` wire
 * passthrough merging last on both the stream and non-stream paths (D9). The
 * core's own mapping/parsing is covered by openai_compatible_native.test.ts;
 * here the assertions target the dialect the factory constructs. No live
 * network; fetch is stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurnRequest } from '../../types.js'
import { create_openrouter_adapter } from '../openrouter.js'
import type { NativeProviderAdapter } from '../types.js'
import { engine_config_error } from '../../errors.js'

function make_req(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    step_index: 0,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    abort: new AbortController().signal,
    stream: false,
    model_id: 'anthropic/claude-sonnet-4.5',
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
  id: 'gen-01',
  object: 'chat.completion',
  model: 'anthropic/claude-sonnet-4.5',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
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
  { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  '[DONE]',
]

function native_adapter(init: Record<string, unknown> = {}): NativeProviderAdapter {
  const adapter = create_openrouter_adapter({ api_key: 'sk-test', transport: 'native', ...init })
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
    expect(create_openrouter_adapter({ api_key: 'sk-test' }).kind).toBe('ai_sdk')
  })

  it("returns the ai_sdk adapter for transport: 'ai_sdk'", () => {
    expect(create_openrouter_adapter({ api_key: 'sk-test', transport: 'ai_sdk' }).kind).toBe('ai_sdk')
  })

  it("returns the native adapter for transport: 'native', keeping the provider name", () => {
    const adapter = create_openrouter_adapter({ api_key: 'sk-test', transport: 'native' })
    expect(adapter.kind).toBe('native')
    expect(adapter.name).toBe('openrouter')
  })

  it('throws engine_config_error on an unknown transport', () => {
    expect(() => create_openrouter_adapter({ api_key: 'sk-test', transport: 'grpc' })).toThrow(
      engine_config_error,
    )
  })

  it('throws engine_config_error on native with an empty api_key (rides on the core)', () => {
    expect(() => create_openrouter_adapter({ api_key: '', transport: 'native' })).toThrow(
      engine_config_error,
    )
  })
})

describe('openrouter native dialect wiring', () => {
  it('POSTs to the openrouter chat/completions endpoint with Bearer auth', async () => {
    const { url, headers } = await sent_body({}, {})
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(headers['authorization']).toBe('Bearer sk-test')
    expect(headers['content-type']).toBe('application/json')
  })

  it('sends the HTTP-Referer and X-Title headers when set', async () => {
    const { headers } = await sent_body(
      { http_referer: 'https://app.example', x_title: 'My App' },
      {},
    )
    expect(headers['HTTP-Referer']).toBe('https://app.example')
    expect(headers['X-Title']).toBe('My App')
  })

  it('sends only the referer header when x_title is absent', async () => {
    const { headers } = await sent_body({ http_referer: 'https://app.example' }, {})
    expect(headers['HTTP-Referer']).toBe('https://app.example')
    expect(headers).not.toHaveProperty('X-Title')
  })

  it('omits both attribution headers when neither is set', async () => {
    const { headers } = await sent_body({}, {})
    expect(headers).not.toHaveProperty('HTTP-Referer')
    expect(headers).not.toHaveProperty('X-Title')
  })

  it('respects a base_url override', async () => {
    const { url } = await sent_body({ base_url: 'https://proxy.local/api/v1' }, {})
    expect(url).toBe('https://proxy.local/api/v1/chat/completions')
  })

  it('writes the token limit to max_tokens, not max_completion_tokens', async () => {
    const { body } = await sent_body({}, { max_tokens: 1000 })
    expect(body['max_tokens']).toBe(1000)
    expect(body).not.toHaveProperty('max_completion_tokens')
  })

  it.each([
    ['none', undefined],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
  ] as const)('maps effort %s to reasoning_effort %s (A4)', async (effort, expected) => {
    const { body } = await sent_body({}, { effort })
    if (expected === undefined) {
      expect(body).not.toHaveProperty('reasoning_effort')
    } else {
      expect(body['reasoning_effort']).toBe(expected)
    }
  })
})

describe('provider_options.openrouter passthrough (D9)', () => {
  it('merges wire keys last over derived fields on the non-stream path', async () => {
    const { body } = await sent_body(
      {},
      {
        effort: 'medium',
        max_tokens: 1000,
        provider_options: { openrouter: { max_tokens: 512, reasoning: { max_tokens: 2048 } } },
      },
    )
    // The passthrough token limit beats the engine-derived one.
    expect(body['max_tokens']).toBe(512)
    // A passthrough-only key rides through untouched.
    expect(body['reasoning']).toEqual({ max_tokens: 2048 })
    // A derived field with no override is left in place.
    expect(body['reasoning_effort']).toBe('medium')
  })

  it('merges wire keys last over derived fields on the stream path', async () => {
    const body = await streamed_body(
      {},
      {
        effort: 'medium',
        max_tokens: 1000,
        provider_options: { openrouter: { max_tokens: 512, transforms: ['middle-out'] } },
      },
    )
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toEqual({ include_usage: true })
    expect(body['max_tokens']).toBe(512)
    expect(body['transforms']).toEqual(['middle-out'])
    expect(body['reasoning_effort']).toBe('medium')
  })

  it('ignores provider_options keyed to other providers', async () => {
    const { body } = await sent_body({}, { provider_options: { openai: { logprobs: true } } })
    expect(body).not.toHaveProperty('logprobs')
  })
})
