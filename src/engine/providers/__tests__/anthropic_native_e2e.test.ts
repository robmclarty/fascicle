/**
 * Native Anthropic end-to-end: the real adapter selected via
 * `transport: 'native'` and driven through create_engine -> generate ->
 * run_tool_loop on recorded Messages-API fixtures (fetch stubbed, so no test
 * reaches the network). Pins the loop features the adapter inherits (approval,
 * salvage, Tool.ends_turn, cost) plus the wire shapes fed back to the API
 * mid-loop. Every turn asks for a stream, so the stubs serve SSE, and a run
 * with a chunk consumer folds to the same result as a run without one. A JSON
 * reply to a streamed request, a reply that is neither, and a stream cut off
 * before message_stop are pinned at the end.
 * Zero `ai` in this file's module graph, enforced by
 * rules/no-ai-sdk-in-native-providers.yml (the *native* glob covers it).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { create_engine } from '../../create_engine.js'
import { provider_capability_error, provider_error, tool_approval_denied_error } from '../../errors.js'
import type { GenerateResult, Message, RetryPolicy, StreamChunk, Tool } from '../../types.js'

const MODEL = 'claude-sonnet-5'

function make_engine(): ReturnType<typeof create_engine> {
  return create_engine({
    providers: { anthropic: { api_key: 'sk-test', transport: 'native' } },
    pricing: {
      [`anthropic:${MODEL}`]: { input_per_million: 10, output_per_million: 20 },
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

function sse_response(events: ReadonlyArray<Record<string, unknown>>): Response {
  const payload = events
    .map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`)
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
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [
    { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 500 },
}

/** Turn 2: the model answers from the fed-back tool result. */
const FINAL_TURN_FIXTURE = {
  id: 'msg_02',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [{ type: 'text', text: 'The weather in Ottawa is sunny.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 2000, output_tokens: 1000 },
}

const TOOL_TURN_STREAM = [
  {
    type: 'message_start',
    message: { id: 'msg_01', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 2 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city": ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"Ottawa"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 500 } },
  { type: 'message_stop' },
]

const FINAL_TURN_STREAM = [
  {
    type: 'message_start',
    message: { id: 'msg_02', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 2000, output_tokens: 2 } },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The weather in Ottawa ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is sunny.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1000 } },
  { type: 'message_stop' },
]

/**
 * The SSE events that deliver a whole Messages response's text and tool_use
 * blocks, for a fixture that has no hand-written stream of its own.
 */
function message_stream(message: {
  id: string
  content: ReadonlyArray<Record<string, unknown>>
  stop_reason: string
  usage: { input_tokens: number; output_tokens: number }
}): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: { id: message.id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 1 } },
    },
  ]
  message.content.forEach((block, index) => {
    if (block['type'] === 'text') {
      events.push(
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block['text'] } },
      )
    } else {
      events.push(
        { type: 'content_block_start', index, content_block: { ...block, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block['input']) } },
      )
    }
    events.push({ type: 'content_block_stop', index })
  })
  events.push(
    { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } },
    { type: 'message_stop' },
  )
  return events
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

describe('native anthropic e2e tool loop (no consumer)', () => {
  it('runs the approval-gated loop with cost and feeds wire-shape tool results back', async () => {
    const { result, mock, weather, approvals } = await run_weather_loop(false)

    expect(weather.calls).toEqual([{ city: 'Ottawa' }])
    expect(approvals).toEqual([{ tool_name: 'get_weather', input: { city: 'Ottawa' } }])
    expect(result.content).toBe('The weather in Ottawa is sunny.')
    expect(result.finish_reason).toBe('stop')
    expect(result.steps).toHaveLength(2)
    expect(result.tool_calls).toHaveLength(1)
    expect(result.tool_calls[0]).toMatchObject({
      id: 'toolu_01',
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
    // tool_use turn and the fed-back tool_result block.
    expect(mock).toHaveBeenCalledTimes(2)
    // Every turn asks for a stream, though nothing consumes the chunks.
    expect(request_bodies(mock).map((body) => body['stream'])).toStrictEqual([true, true])
    const second_call = mock.mock.calls[1] as [string, RequestInit]
    expect(second_call[0]).toBe('https://api.anthropic.com/v1/messages')
    const second_body = JSON.parse(second_call[1].body as string) as Record<string, unknown>
    expect(second_body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather in Ottawa?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'sunny' }],
      },
    ])
  })
})

describe('native anthropic e2e tool loop (with a consumer)', () => {
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
      id: 'toolu_01',
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
      id: 'toolu_01',
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

describe('native anthropic e2e salvage', () => {
  it('salvages a text-format tool call and feeds the structured shapes back on the wire', async () => {
    const salvage_fixture = {
      ...FINAL_TURN_FIXTURE,
      id: 'msg_s1',
      content: [
        {
          type: 'text',
          text: '<tool_call>{"name":"get_weather","arguments":{"city":"Ottawa"}}</tool_call>',
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    }
    const mock = stub_fetch_queue([
      sse_response(message_stream(salvage_fixture)),
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
      { role: 'user', content: [{ type: 'text', text: 'weather in Ottawa?' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'salvaged_0_0',
            name: 'get_weather',
            input: { city: 'Ottawa' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'salvaged_0_0', content: 'sunny' }],
      },
    ])
  })
})

describe('native anthropic e2e ends_turn', () => {
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
    expect(result.tool_calls[0]).toMatchObject({ id: 'toolu_01', output: 'sunny' })
  })
})

describe('native anthropic e2e fail-closed approval', () => {
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
// Thinking across the loop: the second request carries the
// first turn's thinking and redacted_thinking blocks exactly as received, in
// block order, empty thinking text included.
// ---------------------------------------------------------------------------

const THINKING_TOOL_TURN_STREAM = [
  TOOL_TURN_STREAM[0],
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Ottawa needs ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a lookup.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_1' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Checking.' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'signature_delta', signature: 'sig_2' } },
  { type: 'content_block_stop', index: 3 },
  // The tool_use block, re-indexed to follow the thinking blocks.
  ...TOOL_TURN_STREAM.slice(1, 5).map((event) => ({ ...event, index: 4 })),
  ...TOOL_TURN_STREAM.slice(5),
]

describe('native anthropic e2e thinking round trip', () => {
  it.each([false, true])(
    "sends the first turn's blocks back exactly as received (consumer: %s)",
    async (consumer) => {
      const mock = stub_fetch_queue([
        sse_response(THINKING_TOOL_TURN_STREAM as Array<Record<string, unknown>>),
        sse_response(FINAL_TURN_STREAM),
      ])
      const weather = make_weather_tool()
      const result = await make_engine().generate({
        model: MODEL,
        prompt: 'weather in Ottawa?',
        tools: [weather],
        ...(consumer ? { on_chunk: () => {} } : {}),
      })

      expect(weather.calls).toEqual([{ city: 'Ottawa' }])
      expect(result.content).toBe('The weather in Ottawa is sunny.')
      const second = mock.mock.calls[1] as [string, RequestInit]
      const body = JSON.parse(second[1].body as string) as Record<string, unknown>
      expect(body['messages']).toStrictEqual([
        { role: 'user', content: [{ type: 'text', text: 'weather in Ottawa?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Ottawa needs a lookup.', signature: 'sig_1' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'Checking.' },
            { type: 'thinking', thinking: '', signature: 'sig_2' },
            { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'sunny' }],
        },
      ])
    },
  )
})

describe('native anthropic e2e request mapping errors', () => {
  it.each<[string, Message[], string]>([
    [
      'an image part',
      [{ role: 'user', content: [{ type: 'image', image: 'aGk=', media_type: 'image/png' }] }],
      'image_input',
    ],
    [
      'a mid-conversation system message',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'system', content: 'late rule' },
        { role: 'user', content: 'again' },
      ],
      'mid_conversation_system_messages',
    ],
  ])('surfaces the typed capability error for %s without a request or a retry', async (_label, prompt, capability) => {
    const mock = stub_fetch_queue([])
    const events: Array<Record<string, unknown>> = []
    const caught = await make_engine()
      .generate({
        model: MODEL,
        prompt,
        // A network-retrying policy with no backoff, so a mapper error
        // misread as a network failure would show up as turn_retry events.
        retry: { max_attempts: 3, initial_delay_ms: 0, max_delay_ms: 0, retry_on: ['network'] },
        trajectory: {
          record: (e) => {
            events.push(e)
          },
          start_span: () => 'span',
          end_span: () => {},
        },
      })
      .catch((e: unknown) => e)

    expect(caught).toBeInstanceOf(provider_capability_error)
    expect((caught as provider_capability_error).capability).toBe(capability)
    expect(mock).not.toHaveBeenCalled()
    expect(events.filter((e) => e['kind'] === 'turn_retry')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The replies a streamed request can get back: whole JSON, something that
// isn't JSON, and a stream cut off before message_stop.
// ---------------------------------------------------------------------------

const NO_WAIT: RetryPolicy = { max_attempts: 3, initial_delay_ms: 0, max_delay_ms: 0, retry_on: ['network'] }

/** The weather stream with its closing message_stop dropped. */
const CUT_TOOL_TURN_STREAM = TOOL_TURN_STREAM.slice(0, -1)

describe('native anthropic e2e reply shapes', () => {
  it('reads a JSON reply to a streamed request as a whole body, and fails one that is neither with the base_url hint', async () => {
    const streamed = await run_weather_loop(false)
    vi.unstubAllGlobals()
    const whole = await run_weather_loop(false, [
      json_response(TOOL_TURN_FIXTURE),
      json_response(FINAL_TURN_FIXTURE),
    ])

    expect(request_bodies(whole.mock).map((body) => body['stream'])).toStrictEqual([true, true])
    expect(without_timing(whole.result)).toEqual(without_timing(streamed.result))

    // A media type compares without its parameters and its case.
    vi.unstubAllGlobals()
    const odd = [sse_response(TOOL_TURN_STREAM), sse_response(FINAL_TURN_STREAM)]
    for (const response of odd) response.headers.set('content-type', ' Text/Event-Stream ; charset=UTF-8')
    const parameterized = await run_weather_loop(false, odd)
    expect(without_timing(parameterized.result)).toEqual(without_timing(streamed.result))

    vi.unstubAllGlobals()
    stub_fetch_queue([
      new Response('<html>not the API</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ])
    const caught = await make_engine()
      .generate({ model: MODEL, prompt: 'hi', retry: NO_WAIT })
      .catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(provider_error)
    expect((caught as Error).message).toMatch(
      /^anthropic native: response body is not valid JSON: check that base_url points at the anthropic API/,
    )
  })

  it('retries a stream cut off before message_stop with no consumer, and fails it as stream interrupted with one', async () => {
    const retries: Array<Record<string, unknown>> = []
    const mock = stub_fetch_queue([
      sse_response(CUT_TOOL_TURN_STREAM),
      sse_response(TOOL_TURN_STREAM),
      sse_response(FINAL_TURN_STREAM),
    ])
    const result = await make_engine().generate({
      model: MODEL,
      prompt: 'weather in Ottawa?',
      tools: [make_weather_tool()],
      retry: NO_WAIT,
      trajectory: {
        record: (e) => {
          if (e.kind === 'turn_retry') retries.push(e)
        },
        start_span: () => 'span',
        end_span: () => {},
      },
    })

    expect(mock).toHaveBeenCalledTimes(3)
    expect(result.content).toBe('The weather in Ottawa is sunny.')
    expect(retries).toMatchObject([{ step_index: 0, failure_kind: 'network' }])

    vi.unstubAllGlobals()
    const watched = stub_fetch_queue([sse_response(CUT_TOOL_TURN_STREAM), sse_response(TOOL_TURN_STREAM)])
    const caught = await make_engine()
      .generate({
        model: MODEL,
        prompt: 'hi',
        tools: [make_weather_tool()],
        retry: NO_WAIT,
        on_chunk: () => {},
      })
      .catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(provider_error)
    expect((caught as Error).message).toBe(
      'stream interrupted: anthropic native: stream ended before message_stop; the result would be truncated',
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
      .generate({ model: MODEL, prompt: 'hi', tools: [make_weather_tool()], retry: NO_WAIT })
      .catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(provider_error)
    expect(caught).toMatchObject({
      cause_kind: 'network',
      message: 'anthropic native: stream ended before message_stop; the result would be truncated',
    })
  })
})
