/**
 * OpenRouter provider, native transport wiring (Step 4). Proves `transport:
 * 'native'` routes through the shared OpenAI-compatible core with the openrouter
 * dialect: Bearer auth, the optional `HTTP-Referer`/`X-Title` attribution
 * headers, `max_tokens` as the token-limit field (not `max_completion_tokens`),
 * effort as the nested `reasoning: { effort }` per D4 (nested-effort-openrouter),
 * and `provider_options.openrouter` wire
 * passthrough merging last on both the stream and non-stream paths (D9). The
 * core's own mapping/parsing is covered by openai_compatible_native.test.ts;
 * here the assertions target the dialect the factory constructs, and the
 * engine-level cases below drive the reported cost through generate. No live
 * network; fetch is stubbed per test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import type { PricingTable, StreamChunk, Tool, TurnRequest } from '../../types.js'
import { create_engine } from '../../create_engine.js'
import { decompose_total_cost } from '../../pricing.js'
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

  it('throws engine_config_error on an unknown transport, naming the provider', () => {
    expect(() => create_openrouter_adapter({ api_key: 'sk-test', transport: 'grpc' })).toThrow(
      engine_config_error,
    )
    expect(() => create_openrouter_adapter({ api_key: 'sk-test', transport: 'grpc' })).toThrow(
      `openrouter provider: transport must be 'ai_sdk' or 'native', got "grpc"`,
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

  it('ignores attribution values that are not strings', async () => {
    const { headers } = await sent_body({ http_referer: 42, x_title: true }, {})
    expect(headers).not.toHaveProperty('HTTP-Referer')
    expect(headers).not.toHaveProperty('X-Title')
  })

  it('treats a response without usage as broken (strict usage)', async () => {
    stub_fetch(json_response({ ...TEXT_FIXTURE, usage: undefined }))
    await expect(native_adapter().invoke_turn(make_req())).rejects.toThrow(
      'openrouter native: response is missing its usage object',
    )
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

  // D4 (nested-effort-openrouter): every level passes through unclamped.
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'sends effort %s as reasoning: { effort }, never the flat field',
    async (effort) => {
      const { body } = await sent_body({}, { effort })
      expect(body['reasoning']).toStrictEqual({ effort })
      expect(body).not.toHaveProperty('reasoning_effort')
    },
  )

  it('sends no effort field for effort none', async () => {
    const { body } = await sent_body({}, { effort: 'none' })
    expect(body).not.toHaveProperty('reasoning')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('sends the nested effort on the stream path too', async () => {
    const body = await streamed_body({}, { effort: 'max' })
    expect(body['reasoning']).toStrictEqual({ effort: 'max' })
    expect(body).not.toHaveProperty('reasoning_effort')
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
    // The merge is shallow, so a passthrough reasoning object replaces the
    // effort-derived one whole.
    expect(body['reasoning']).toStrictEqual({ max_tokens: 2048 })
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('leaves the effort-derived reasoning in place when nothing overrides it', async () => {
    const { body } = await sent_body(
      {},
      { effort: 'medium', provider_options: { openrouter: { transforms: ['middle-out'] } } },
    )
    expect(body['reasoning']).toStrictEqual({ effort: 'medium' })
    expect(body['transforms']).toEqual(['middle-out'])
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
    expect(body['reasoning']).toStrictEqual({ effort: 'medium' })
  })

  it('ignores provider_options keyed to other providers', async () => {
    const { body } = await sent_body({}, { provider_options: { openai: { logprobs: true } } })
    expect(body).not.toHaveProperty('logprobs')
  })
})

describe('openrouter native reasoning (the spec 1.2)', () => {
  const ENTRY = {
    type: 'reasoning.text',
    text: 'think',
    signature: 'sig_or',
    format: 'anthropic-claude-v1',
    index: 0,
  }

  it('reads reasoning_details into parts keyed openrouter, streamed and not', async () => {
    stub_fetch(
      json_response({
        ...TEXT_FIXTURE,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello there', reasoning_details: [ENTRY] },
            finish_reason: 'stop',
          },
        ],
      }),
    )
    const whole = await native_adapter().invoke_turn(make_req())
    expect(whole.content).toStrictEqual([
      { type: 'reasoning', text: 'think', provider_options: { openrouter: { detail: ENTRY } } },
      { type: 'text', text: 'Hello there' },
    ])

    const chunks: string[] = []
    stub_fetch(
      sse_response([
        { choices: [{ index: 0, delta: { reasoning_details: [ENTRY] } }] },
        ...TEXT_STREAM,
      ]),
    )
    const streamed = await native_adapter().invoke_turn(
      make_req({
        stream: true,
        dispatch_chunk: async (chunk) => {
          if (chunk.kind === 'reasoning') chunks.push(chunk.text)
        },
      }),
    )
    expect(chunks).toStrictEqual(['think'])
    expect(streamed.content?.[0]).toStrictEqual({
      type: 'reasoning',
      text: 'think',
      provider_options: { openrouter: { detail: ENTRY } },
    })
  })

  it("sends a turn's own entries back as reasoning_details", async () => {
    const { body } = await sent_body(
      {},
      {
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'think', provider_options: { openrouter: { detail: ENTRY } } },
              { type: 'text', text: 'Hello' },
            ],
          },
          { role: 'user', content: 'again' },
        ],
      },
    )
    expect(body['messages']).toStrictEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello', reasoning_details: [ENTRY] },
      { role: 'user', content: 'again' },
    ])
  })
})

const COST_MODEL = 'anthropic/claude-sonnet-5.5'

function stub_fetch_queue(responses: Response[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const next = responses.shift()
      if (next === undefined) throw new Error('fetch queue exhausted')
      return next
    }),
  )
}

function record_trajectory(): { trajectory: TrajectoryLogger; records: TrajectoryEvent[] } {
  const records: TrajectoryEvent[] = []
  let counter = 0
  const trajectory: TrajectoryLogger = {
    record(event) {
      records.push(event)
    },
    start_span() {
      counter += 1
      return `span-${counter}`
    },
    end_span() {},
  }
  return { trajectory, records }
}

function cost_engine(pricing?: PricingTable): ReturnType<typeof create_engine> {
  return create_engine({
    providers: { openrouter: { api_key: 'sk-test', transport: 'native' } },
    ...(pricing !== undefined ? { pricing } : {}),
  })
}

const COST_USAGE = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } }

/** One turn, whole or streamed, whose usage reports `cost` (or none when undefined). */
function cost_turn(
  streamed: boolean,
  cost: number | undefined,
  tool_call?: { id: string; arguments: string },
): Response {
  const usage = cost === undefined ? COST_USAGE : { ...COST_USAGE, cost, is_byok: false, cost_details: { upstream_inference_cost: null } }
  const finish_reason = tool_call === undefined ? 'stop' : 'tool_calls'
  const calls =
    tool_call === undefined
      ? undefined
      : [{ id: tool_call.id, type: 'function', function: { name: 'lookup', arguments: tool_call.arguments } }]
  if (!streamed) {
    const message = { role: 'assistant', content: tool_call === undefined ? 'done' : null, ...(calls !== undefined ? { tool_calls: calls } : {}) }
    return json_response({ choices: [{ index: 0, message, finish_reason }], usage })
  }
  const delta = calls !== undefined ? { tool_calls: calls.map((c, index) => ({ index, ...c })) } : { content: 'done' }
  return sse_response([
    { choices: [{ index: 0, delta: { role: 'assistant', ...delta } }] },
    { choices: [{ index: 0, delta: {}, finish_reason }] },
    { choices: [{ index: 0, delta: {}, finish_reason }], usage },
    '[DONE]',
  ])
}

const lookup_tool: Tool = {
  name: 'lookup',
  description: 'Look a key up',
  input_schema: z.object({ key: z.string() }),
  execute: () => 'value',
}

describe('the cost OpenRouter reports, through generate (the spec Part 2)', () => {
  it.each([false, true])(
    'records the reported charge split by token weight, streamed %s, with no pricing_missing',
    async (streamed) => {
      stub_fetch_queue([cost_turn(streamed, 0.0042)])
      const { trajectory, records } = record_trajectory()
      const result = await cost_engine().generate({
        model: COST_MODEL,
        prompt: 'hi',
        trajectory,
        ...(streamed ? { on_chunk: (_chunk: StreamChunk) => {} } : {}),
      })
      const usage = { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 400 }
      expect(result.steps[0]?.cost).toStrictEqual(decompose_total_cost(0.0042, usage))
      expect(result.cost?.total_usd).toBeCloseTo(0.0042, 12)
      expect(records.filter((e) => e.kind === 'pricing_missing')).toStrictEqual([])
      const cost_events = records.filter((e) => e.kind === 'cost')
      expect(cost_events).toHaveLength(1)
      expect(cost_events[0]).toMatchObject({ source: 'provider_reported', total_usd: 0.0042 })
      expect(result.steps[0]?.provider_reported).toStrictEqual({
        openrouter: { cost: 0.0042, is_byok: false, cost_details: { upstream_inference_cost: null } },
      })
    },
  )

  it.each([false, true])(
    "sums a two-step tool loop's reported charges into GenerateResult.cost, streamed %s",
    async (streamed) => {
      stub_fetch_queue([
        cost_turn(streamed, 0.003, { id: 'call_1', arguments: '{"key":"a"}' }),
        cost_turn(streamed, 0.0015),
      ])
      const result = await cost_engine().generate({
        model: COST_MODEL,
        prompt: 'look a up',
        tools: [lookup_tool],
        ...(streamed ? { on_chunk: (_chunk: StreamChunk) => {} } : {}),
      })
      expect(result.steps.map((step) => step.cost?.total_usd)).toStrictEqual([0.003, 0.0015])
      expect(result.cost?.total_usd).toBeCloseTo(0.0045, 12)
    },
  )

  it('takes the reported charge over a pricing row for the same model (D10)', async () => {
    stub_fetch_queue([cost_turn(false, 0.0042)])
    const { trajectory, records } = record_trajectory()
    const result = await cost_engine({
      [`openrouter:${COST_MODEL}`]: { input_per_million: 100, output_per_million: 100 },
    }).generate({ model: COST_MODEL, prompt: 'hi', trajectory })
    expect(result.cost?.total_usd).toBeCloseTo(0.0042, 12)
    expect(records.filter((e) => e.kind === 'cost').map((e) => e['source'])).toStrictEqual([
      'provider_reported',
    ])
  })

  it('emits pricing_missing once and records no cost when no charge is reported', async () => {
    stub_fetch_queue([
      cost_turn(false, undefined, { id: 'call_1', arguments: '{"key":"a"}' }),
      cost_turn(false, undefined),
    ])
    const { trajectory, records } = record_trajectory()
    const result = await cost_engine().generate({
      model: COST_MODEL,
      prompt: 'look a up',
      tools: [lookup_tool],
      trajectory,
    })
    expect('cost' in result).toBe(false)
    expect(records.filter((e) => e.kind === 'cost')).toStrictEqual([])
    expect(records.filter((e) => e.kind === 'pricing_missing')).toHaveLength(1)
  })
})
