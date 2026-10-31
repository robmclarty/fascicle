/**
 * OpenAI-compatible native end-to-end: the real adapter driven through
 * create_engine -> generate -> run_tool_loop on recorded chat/completions
 * fixtures (fetch stubbed, so no test reaches the network). Registered via
 * custom_providers with a bare dialect rather than through a built-in factory,
 * so the loop behavior pinned here is the core's own, which the `openai`,
 * `openrouter`, and `lmstudio` native branches inherit. Pins the loop
 * features the adapter inherits (approval, salvage, Tool.ends_turn, cost)
 * plus the wire shapes fed back to the API mid-loop. Every turn asks for a
 * stream, so the stubs serve SSE, and a run with a chunk consumer folds to the
 * same result as a run without one. A JSON reply to a streamed request, a
 * reply that is neither, and a stream cut off before [DONE] are pinned at the
 * end. Zero `ai` in this file's
 * module graph, enforced by
 * rules/no-ai-sdk-in-native-providers.yml (the *native* glob covers it).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { create_engine } from '../../create_engine.js'
import { provider_error, tool_approval_denied_error } from '../../errors.js'
import { create_openai_compatible_adapter } from '../openai_compatible_native.js'
import type { GenerateResult, RetryPolicy, StreamChunk, Tool } from '../../types.js'

const MODEL = 'gpt-test'

function make_engine(): ReturnType<typeof create_engine> {
  return create_engine({
    providers: { compat: {} },
    custom_providers: {
      compat: () =>
        create_openai_compatible_adapter({
          name: 'compat',
          base_url: 'http://localhost:8080/v1',
          auth: { kind: 'bearer', api_key: 'sk-test' },
          token_limit_field: 'max_tokens',
          stream_include_usage: true,
          tolerant_usage: false,
          reports_cost: false,
        }),
    },
    pricing: {
      [`compat:${MODEL}`]: { input_per_million: 10, output_per_million: 20 },
    },
  })
}

function make_weather_tool(overrides?: Partial<Tool>): Tool & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    name: 'get_weather',
    description: 'Look up current weather for a city',
    input_schema: z.object({ city: z.string() }),
    execute: (input: unknown) => {
      calls.push(input)
      return 'sunny'
    },
    ...overrides,
    calls,
  }
}

function stub_fetch_queue(responses: Response[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift()
    if (next === undefined) throw new Error('fetch queue exhausted')
    return next
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function json_response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function sse_response(frames: ReadonlyArray<Record<string, unknown> | '[DONE]'>): Response {
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

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Turn 1: the model calls get_weather for Ottawa. */
const TOOL_TURN_FIXTURE = {
  id: 'chatcmpl-e2e-01',
  object: 'chat.completion',
  model: MODEL,
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
  usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
}

/** Turn 2: the model answers from the fed-back tool result. */
const FINAL_TURN_FIXTURE = {
  id: 'chatcmpl-e2e-02',
  object: 'chat.completion',
  model: MODEL,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'The weather in Ottawa is sunny.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 2000, completion_tokens: 1000, total_tokens: 3000 },
}

const TOOL_TURN_STREAM: Array<Record<string, unknown> | '[DONE]'> = [
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
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city": ' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Ottawa"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } },
  '[DONE]',
]

const FINAL_TURN_STREAM: Array<Record<string, unknown> | '[DONE]'> = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  { choices: [{ index: 0, delta: { content: 'The weather in Ottawa ' } }] },
  { choices: [{ index: 0, delta: { content: 'is sunny.' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 2000, completion_tokens: 1000, total_tokens: 3000 } },
  '[DONE]',
]

/**
 * The SSE frames that deliver a whole chat completion whose message is text,
 * for a fixture that has no hand-written stream of its own.
 */
function completion_stream(completion: {
  choices: ReadonlyArray<{ message: { content: string }; finish_reason: string }>
  usage: Record<string, number>
}): Array<Record<string, unknown> | '[DONE]'> {
  const choice = completion.choices[0]
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', content: choice?.message.content } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason }] },
    { choices: [], usage: completion.usage },
    '[DONE]',
  ]
}

/** ToolCallRecords carry wall-clock timing; drop it so runs compare deeply. */
function strip_timing(records: GenerateResult['tool_calls']): unknown {
  return records.map(({ duration_ms: _d, started_at: _s, ...rest }) => rest)
}

function without_timing({ timing: _call, ...result }: GenerateResult): unknown {
  return {
    ...result,
    tool_calls: strip_timing(result.tool_calls),
    // StepTiming and the call-level timing are wall-clock too (and only
    // streamed runs get first_chunk_ms).
    steps: result.steps.map(({ timing: _t, ...step }) => ({
      ...step,
      tool_calls: strip_timing(step.tool_calls),
    })),
  }
}

async function run_weather_loop(
  consumer: boolean,
  responses: Response[] = [sse_response(TOOL_TURN_STREAM), sse_response(FINAL_TURN_STREAM)],
): Promise<{
  result: GenerateResult
  chunks: StreamChunk[]
  mock: ReturnType<typeof vi.fn>
  weather: Tool & { calls: unknown[] }
  approvals: Array<{ tool_name: string; input: unknown }>
}> {
  const mock = stub_fetch_queue(responses)
  const weather = make_weather_tool({ needs_approval: true })
  const approvals: Array<{ tool_name: string; input: unknown }> = []
  const chunks: StreamChunk[] = []
  const engine = make_engine()
  const result = await engine.generate({
    model: MODEL,
    prompt: 'weather in Ottawa?',
    tools: [weather],
    on_tool_approval: (req) => {
      approvals.push({ tool_name: req.tool_name, input: req.input })
      return true
    },
    ...(consumer
      ? {
          on_chunk: (chunk: StreamChunk) => {
            chunks.push(chunk)
          },
        }
      : {}),
  })
  return { result, chunks, mock, weather, approvals }
}

/** Each request body the stubbed fetch was sent, parsed. */
function request_bodies(mock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return mock.mock.calls.map(
    (call) => JSON.parse((call as [string, RequestInit])[1].body as string) as Record<string, unknown>,
  )
}

describe('openai-compatible native e2e tool loop (no consumer)', () => {
  it('runs the approval-gated loop with cost and feeds wire-shape tool results back', async () => {
    const { result, mock, weather, approvals } = await run_weather_loop(false)

    expect(weather.calls).toEqual([{ city: 'Ottawa' }])
    expect(approvals).toEqual([{ tool_name: 'get_weather', input: { city: 'Ottawa' } }])
    expect(result.content).toBe('The weather in Ottawa is sunny.')
    expect(result.finish_reason).toBe('stop')
    expect(result.steps).toHaveLength(2)
    expect(result.tool_calls).toHaveLength(1)
    expect(result.tool_calls[0]).toMatchObject({
      id: 'call_01',
      name: 'get_weather',
      input: { city: 'Ottawa' },
      output: 'sunny',
    })
    expect(result.usage).toEqual({ input_tokens: 3000, output_tokens: 1500 })
    // 1000 in * $10/M + 500 out * $20/M = 0.02; 2000 in + 1000 out = 0.04.
    expect(result.steps[0]?.cost).toMatchObject({ total_usd: 0.02 })
    expect(result.steps[1]?.cost).toMatchObject({ total_usd: 0.04 })
    expect(result.cost).toMatchObject({
      total_usd: 0.06,
      input_usd: 0.03,
      output_usd: 0.03,
      currency: 'USD',
    })

    // The second request carries the whole loop on the wire: the assistant
    // tool_calls turn and the fed-back tool role message.
    expect(mock).toHaveBeenCalledTimes(2)
    // Every turn asks for a stream, and for its usage, though nothing consumes the chunks.
    expect(request_bodies(mock).map((body) => [body['stream'], body['stream_options']])).toStrictEqual([
      [true, { include_usage: true }],
      [true, { include_usage: true }],
    ])
    const second_call = mock.mock.calls[1] as [string, RequestInit]
    expect(second_call[0]).toBe('http://localhost:8080/v1/chat/completions')
    const second_body = JSON.parse(second_call[1].body as string) as Record<string, unknown>
    expect(second_body['messages']).toEqual([
      { role: 'user', content: 'weather in Ottawa?' },
      {
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
      { role: 'tool', tool_call_id: 'call_01', content: 'sunny' },
    ])
  })
})

describe('openai-compatible native e2e tool loop (with a consumer)', () => {
  it('produces a result equal to the run without one', async () => {
    const without = await run_weather_loop(false)
    vi.unstubAllGlobals()
    const with_consumer = await run_weather_loop(true)

    expect(without_timing(with_consumer.result)).toEqual(without_timing(without.result))
    expect(with_consumer.weather.calls).toEqual([{ city: 'Ottawa' }])
  })

  it('dispatches loop-ordered chunks: tool traffic, results, step and final finishes', async () => {
    const { chunks } = await run_weather_loop(true)

    expect(chunks.map((c) => c.kind)).toEqual([
      'tool_call_start',
      'tool_call_input_delta',
      'tool_call_input_delta',
      'tool_call_end',
      'step_finish',
      'tool_result',
      'text',
      'text',
      'step_finish',
      'finish',
    ])
    expect(chunks[3]).toEqual({
      kind: 'tool_call_end',
      id: 'call_01',
      input: { city: 'Ottawa' },
      step_index: 0,
    })
    expect(chunks[4]).toEqual({
      kind: 'step_finish',
      step_index: 0,
      finish_reason: 'tool_calls',
      usage: { input_tokens: 1000, output_tokens: 500 },
    })
    expect(chunks[5]).toEqual({
      kind: 'tool_result',
      id: 'call_01',
      output: 'sunny',
      step_index: 0,
    })
    expect(chunks.at(-1)).toEqual({
      kind: 'finish',
      finish_reason: 'stop',
      usage: { input_tokens: 3000, output_tokens: 1500 },
    })
  })
})

describe('openai-compatible native e2e salvage', () => {
  it('salvages a text-format tool call and feeds the structured shapes back on the wire', async () => {
    const salvage_fixture = {
      ...FINAL_TURN_FIXTURE,
      id: 'chatcmpl-e2e-s1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content:
              '<tool_call>{"name":"get_weather","arguments":{"city":"Ottawa"}}</tool_call>',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }
    const mock = stub_fetch_queue([
      sse_response(completion_stream(salvage_fixture)),
      sse_response(FINAL_TURN_STREAM),
    ])
    const weather = make_weather_tool()
    const engine = make_engine()

    const result = await engine.generate({
      model: MODEL,
      prompt: 'weather in Ottawa?',
      tools: [weather],
      tool_call_repair_attempts: 1,
    })

    expect(weather.calls).toEqual([{ city: 'Ottawa' }])
    expect(result.content).toBe('The weather in Ottawa is sunny.')
    expect(result.tool_calls[0]).toMatchObject({
      id: 'salvaged_0_0',
      name: 'get_weather',
      salvaged: true,
      salvaged_format: 'hermes',
    })
    const second_body = JSON.parse(
      (mock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>
    // History carries the structured call, not the raw markup.
    expect(second_body['messages']).toEqual([
      { role: 'user', content: 'weather in Ottawa?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'salvaged_0_0',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Ottawa"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'salvaged_0_0', content: 'sunny' },
    ])
  })
})

describe('openai-compatible native e2e ends_turn', () => {
  it('stops after a successful terminal tool call without another request', async () => {
    const mock = stub_fetch_queue([sse_response(TOOL_TURN_STREAM)])
    const weather = make_weather_tool({ ends_turn: true })
    const engine = make_engine()

    const result = await engine.generate({
      model: MODEL,
      prompt: 'weather in Ottawa?',
      tools: [weather],
    })

    expect(mock).toHaveBeenCalledTimes(1)
    expect(weather.calls).toEqual([{ city: 'Ottawa' }])
    expect(result.finish_reason).toBe('stop')
    expect(result.steps[0]?.finish_reason).toBe('tool_calls')
    expect(result.tool_calls[0]).toMatchObject({ id: 'call_01', output: 'sunny' })
  })
})

describe('openai-compatible native e2e fail-closed approval', () => {
  it('denies a needs_approval tool without a handler and never executes it', async () => {
    const mock = stub_fetch_queue([sse_response(TOOL_TURN_STREAM)])
    const weather = make_weather_tool({ needs_approval: true })
    const engine = make_engine()

    await expect(
      engine.generate({ model: MODEL, prompt: 'weather in Ottawa?', tools: [weather] }),
    ).rejects.toThrow(tool_approval_denied_error)

    expect(weather.calls).toEqual([])
    expect(mock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Reasoning across the loop: a reasoning_details dialect
// sends the first turn's entries back with the second request, once, in
// order, unchanged, and never as a `reasoning` string.
// ---------------------------------------------------------------------------

function make_reasoning_engine(): ReturnType<typeof create_engine> {
  return create_engine({
    providers: { compat: {} },
    custom_providers: {
      compat: () =>
        create_openai_compatible_adapter({
          name: 'compat',
          base_url: 'http://localhost:8080/v1',
          auth: { kind: 'bearer', api_key: 'sk-test' },
          token_limit_field: 'max_tokens',
          stream_include_usage: true,
          tolerant_usage: false,
          reports_cost: false,
          effort_shape: 'nested',
          reasoning: 'reasoning_details',
        }),
    },
  })
}

const SIGNED_ENTRY = {
  type: 'reasoning.text',
  text: 'Ottawa needs a lookup.',
  signature: 'sig_e2e',
  format: 'anthropic-claude-v1',
  index: 0,
}
const ENCRYPTED_ENTRY = {
  type: 'reasoning.encrypted',
  data: 'opaque',
  format: 'google-gemini-v1',
  id: 'call_01',
  index: 0,
}

function reasoning_tool_stream(
  finish_reason: string,
  fragments: unknown[],
): Array<Record<string, unknown> | '[DONE]'> {
  return [
    ...fragments.map((fragment) => ({
      choices: [{ index: 0, delta: { content: '', reasoning_details: [fragment] } }],
    })),
    ...TOOL_TURN_STREAM.slice(0, 3),
    { choices: [{ index: 0, delta: {}, finish_reason }] },
    ...TOOL_TURN_STREAM.slice(4),
  ]
}

async function run_reasoning_loop(
  consumer: boolean,
  finish_reason: string,
): Promise<{
  result: GenerateResult
  mock: ReturnType<typeof vi.fn>
  weather: Tool & { calls: unknown[] }
  reasoning: string[]
}> {
  const fragments = [
    { ...SIGNED_ENTRY, text: 'Ottawa needs ', signature: undefined },
    { ...SIGNED_ENTRY, text: 'a lookup.' },
    ENCRYPTED_ENTRY,
  ]
  const mock = stub_fetch_queue([
    sse_response(reasoning_tool_stream(finish_reason, fragments)),
    sse_response(FINAL_TURN_STREAM),
  ])
  const weather = make_weather_tool()
  const reasoning: string[] = []
  const result = await make_reasoning_engine().generate({
    model: MODEL,
    prompt: 'weather in Ottawa?',
    tools: [weather],
    ...(consumer
      ? {
          on_chunk: (chunk: StreamChunk) => {
            if (chunk.kind === 'reasoning') reasoning.push(chunk.text)
          },
        }
      : {}),
  })
  return { result, mock, weather, reasoning }
}

function second_request_messages(mock: ReturnType<typeof vi.fn>): unknown {
  const call = mock.mock.calls[1] as [string, RequestInit]
  return (JSON.parse(call[1].body as string) as Record<string, unknown>)['messages']
}

describe('openai-compatible native e2e reasoning round trip', () => {
  it.each([false, true])(
    "sends the first turn's entries back with the second request (consumer: %s)",
    async (consumer) => {
      const { result, mock, weather } = await run_reasoning_loop(consumer, 'tool_calls')
      expect(weather.calls).toEqual([{ city: 'Ottawa' }])
      expect(result.content).toBe('The weather in Ottawa is sunny.')
      expect(second_request_messages(mock)).toStrictEqual([
        { role: 'user', content: 'weather in Ottawa?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_01',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Ottawa"}' },
            },
          ],
          reasoning_details: [SIGNED_ENTRY, ENCRYPTED_ENTRY],
        },
        { role: 'tool', tool_call_id: 'call_01', content: 'sunny' },
      ])
    },
  )

  it('streams each fragment as a reasoning chunk on the way', async () => {
    const { reasoning } = await run_reasoning_loop(true, 'tool_calls')
    expect(reasoning).toStrictEqual(['Ottawa needs ', 'a lookup.'])
  })

  // Gemini 3 has reported finish_reason 'stop' beside its tool calls; the loop
  // reads tool_calls, never the finish reason, so the tools still run.
  it.each([false, true])(
    'runs the tools of a turn whose finish_reason is stop (consumer: %s)',
    async (consumer) => {
      const { result, mock, weather } = await run_reasoning_loop(consumer, 'stop')
      expect(weather.calls).toEqual([{ city: 'Ottawa' }])
      expect(result.steps).toHaveLength(2)
      expect(result.content).toBe('The weather in Ottawa is sunny.')
      expect(second_request_messages(mock)).toMatchObject([
        {},
        { reasoning_details: [SIGNED_ENTRY, ENCRYPTED_ENTRY] },
        { role: 'tool', tool_call_id: 'call_01' },
      ])
    },
  )
})

/** No backoff waits so the retry cases run instantly. */
const INSTANT_RETRY: RetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 0,
  max_delay_ms: 0,
  retry_on: ['rate_limit', 'provider_5xx', 'network'],
}

/** A stream whose first data frame is a mid-stream error with `code`. */
function error_stream(code: unknown, before: ReadonlyArray<Record<string, unknown>> = []): Response {
  return sse_response([
    ...before,
    {
      error: { code, message: 'Upstream gave out' },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    },
    '[DONE]',
  ])
}

const RECOVERED_STREAM: ReadonlyArray<Record<string, unknown> | '[DONE]'> = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'recovered' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
  '[DONE]',
]

/** Stream one prompt through the engine, keeping the chunks it dispatched. */
async function stream_once(): Promise<{ result?: GenerateResult; thrown?: unknown; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = []
  try {
    const result = await make_engine().generate({
      model: MODEL,
      prompt: 'hi',
      retry: INSTANT_RETRY,
      on_chunk: (chunk: StreamChunk) => {
        chunks.push(chunk)
      },
    })
    return { result, chunks }
  } catch (err: unknown) {
    return { thrown: err, chunks }
  }
}

describe('openai-compatible native e2e error frame mid-stream', () => {
  it.each([429, 502])('retries an error frame with code %i that arrives before any chunk', async (code) => {
    const mock = stub_fetch_queue([error_stream(code), sse_response(RECOVERED_STREAM)])
    const { result, thrown } = await stream_once()
    expect(thrown).toBeUndefined()
    expect(result?.content).toBe('recovered')
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('fails at once on an error frame whose code is not a transient', async () => {
    const mock = stub_fetch_queue([error_stream(400), sse_response(RECOVERED_STREAM)])
    const { thrown } = await stream_once()
    expect(thrown).toBeInstanceOf(provider_error)
    expect(thrown).toMatchObject({
      message: 'compat native: the server reported an error mid-stream (code 400): Upstream gave out',
      status: 400,
    })
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('fails the turn as a stream interruption naming the message once a chunk has streamed', async () => {
    const mock = stub_fetch_queue([
      error_stream(502, [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' } }] }]),
      sse_response(RECOVERED_STREAM),
    ])
    const { thrown, chunks } = await stream_once()
    expect(thrown).toBeInstanceOf(provider_error)
    expect((thrown as provider_error).message).toBe(
      'stream interrupted: compat native: the server reported an error mid-stream (code 502): Upstream gave out',
    )
    expect(chunks.filter((chunk) => chunk.kind === 'text')).toHaveLength(1)
    expect(mock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// The replies a streamed request can get back: whole JSON, something that
// isn't JSON, and a stream cut off before [DONE].
// ---------------------------------------------------------------------------

/** The weather stream with its closing [DONE] dropped. */
const CUT_TOOL_TURN_STREAM = TOOL_TURN_STREAM.slice(0, -1)

describe('openai-compatible native e2e reply shapes', () => {
  it('reads a JSON reply to a streamed request as a whole body, and fails one that is neither with the base_url hint', async () => {
    const streamed = await run_weather_loop(false)
    vi.unstubAllGlobals()
    const whole = await run_weather_loop(false, [
      json_response(TOOL_TURN_FIXTURE),
      json_response(FINAL_TURN_FIXTURE),
    ])

    expect(request_bodies(whole.mock).map((body) => body['stream'])).toStrictEqual([true, true])
    expect(without_timing(whole.result)).toEqual(without_timing(streamed.result))

    vi.unstubAllGlobals()
    stub_fetch_queue([
      new Response('<html>not the API</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ])
    const caught = await make_engine()
      .generate({ model: MODEL, prompt: 'hi', retry: INSTANT_RETRY })
      .catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(provider_error)
    expect((caught as Error).message).toMatch(
      /^compat native: response body is not valid JSON: check that base_url points at the compat API/,
    )
  })

  it('retries a stream cut off before [DONE] with no consumer, and fails it as stream interrupted with one', async () => {
    const mock = stub_fetch_queue([
      sse_response(CUT_TOOL_TURN_STREAM),
      sse_response(TOOL_TURN_STREAM),
      sse_response(FINAL_TURN_STREAM),
    ])
    const result = await make_engine().generate({
      model: MODEL,
      prompt: 'weather in Ottawa?',
      tools: [make_weather_tool()],
      retry: INSTANT_RETRY,
    })
    expect(mock).toHaveBeenCalledTimes(3)
    expect(result.content).toBe('The weather in Ottawa is sunny.')

    vi.unstubAllGlobals()
    const watched = stub_fetch_queue([sse_response(CUT_TOOL_TURN_STREAM), sse_response(TOOL_TURN_STREAM)])
    const caught = await make_engine()
      .generate({
        model: MODEL,
        prompt: 'hi',
        tools: [make_weather_tool()],
        retry: INSTANT_RETRY,
        on_chunk: () => {},
      })
      .catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(provider_error)
    expect((caught as Error).message).toBe(
      'stream interrupted: compat native: stream ended before [DONE]; the result would be truncated',
    )
    expect(watched).toHaveBeenCalledTimes(1)
  })

  it('surfaces an exhausted cut-off stream as a network provider_error', async () => {
    stub_fetch_queue([
      sse_response(CUT_TOOL_TURN_STREAM),
      sse_response(CUT_TOOL_TURN_STREAM),
      sse_response(CUT_TOOL_TURN_STREAM),
    ])
    const caught = await make_engine()
      .generate({ model: MODEL, prompt: 'hi', tools: [make_weather_tool()], retry: INSTANT_RETRY })
      .catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(provider_error)
    expect(caught).toMatchObject({
      cause_kind: 'network',
      message: 'network after 3 attempts: compat native: stream ended before [DONE]; the result would be truncated',
    })
  })
})
