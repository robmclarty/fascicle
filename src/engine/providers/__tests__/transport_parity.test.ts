/**
 * Transport parity golden tests: the payoff of the depth-1 seam.
 *
 * The same recorded provider wire response is driven through BOTH the `ai_sdk`
 * and `native` transports and the resulting TurnResult (text, tool_calls,
 * finish_reason) and UsageTotals are asserted equal to a hand-written golden.
 * Because both transports collapse to one neutral TurnResult, any drift in how
 * the Vercel AI SDK normalizes a turn (usage granularity, finish-reason
 * mapping, tool-call shape) versus the hand-rolled native mapper turns this
 * suite red — which is the whole reason the seam exists.
 *
 * The `ai_sdk` transport streams every turn, so its legs read the SSE bodies,
 * while the native legs read both the JSON and the SSE ones.
 *
 * `provider_reported` sits outside the golden and is pinned on its own: the SDK
 * leg must report under the provider's own key, while the native legs report
 * nothing. See `neutral` for why the two transports are not expected to match
 * there.
 *
 * Wire sharing per provider:
 *   - anthropic: one Messages-API (`/v1/messages`) fixture feeds both legs; the
 *     native adapter and @ai-sdk/anthropic both speak that wire, so this is
 *     literally the same recorded bytes through two transports.
 *   - openai: the native transport speaks `/chat/completions` while
 *     @ai-sdk/openai's default model is the Responses API. To drive ONE recorded
 *     chat/completions request through both legs, the ai_sdk leg is pinned to
 *     the SDK's wire-compatible chat model (`createOpenAI(...).chat`). The
 *     normalization under test (normalize_openai_usage over the SDK's canonical
 *     usage shape) is identical regardless of which OpenAI endpoint produced it.
 *
 * No test reaches the network: fetch is stubbed with recorded fixtures. Tests are
 * exempt from the native-import rules, so importing `ai` / `@ai-sdk/*` here is
 * allowed; production native modules stay SDK-free.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { create_engine } from '../../create_engine.js'
import { provider_error } from '../../errors.js'
import { create_anthropic_adapter } from '../anthropic.js'
import { create_openai_adapter, normalize_openai_usage } from '../openai.js'
import { create_ai_sdk_turn } from '../ai_sdk/invoke.js'
import { create_chunk_dispatcher } from '../../streaming.js'
import {
  translate_effort_to_sdk_reasoning,
  type AiSdkProviderAdapter,
  type NativeProviderAdapter,
  type ProviderAdapter,
  type ProviderCapability,
} from '../types.js'
import type { Message, StreamChunk, Tool, TurnRequest, TurnResult } from '../../types.js'

const SUPPORTED: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
  'image_input',
  'reasoning',
])

const weather_tool: Tool = {
  name: 'get_weather',
  description: 'Look up current weather for a city',
  input_schema: z.object({ city: z.string() }),
  execute: () => 'sunny',
}

const MESSAGES: ReadonlyArray<Message> = [{ role: 'user', content: 'weather in Ottawa?' }]

function as_native(adapter: ProviderAdapter): NativeProviderAdapter {
  if (adapter.kind !== 'native') {
    throw new Error(`expected a native adapter, got ${adapter.kind}`)
  }
  return adapter
}

function as_ai_sdk(adapter: ProviderAdapter): AiSdkProviderAdapter {
  if (adapter.kind !== 'ai_sdk') {
    throw new Error(`expected an ai_sdk adapter, got ${adapter.kind}`)
  }
  return adapter
}

/** Fresh Response per fetch call: a Response body can only be read once. */
function json_factory(payload: unknown): () => Response {
  return () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
}

/** Emit the SSE body in tiny slices so both transports' parsers must buffer. */
function sse_factory(body: string): () => Response {
  return () => {
    const bytes = new TextEncoder().encode(body)
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
}

/** OpenAI chat/completions SSE: `data:` lines with a literal `[DONE]` terminator. */
function openai_sse(frames: ReadonlyArray<Record<string, unknown> | '[DONE]'>): string {
  return frames
    .map((frame) => `data: ${frame === '[DONE]' ? '[DONE]' : JSON.stringify(frame)}\n\n`)
    .join('')
}

/** Anthropic Messages SSE: each event carries an `event:` type line. */
function anthropic_sse(events: ReadonlyArray<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function stub_fetch(factory: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => factory()),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function run_native_turn(
  adapter: NativeProviderAdapter,
  model_id: string,
  stream: boolean,
  messages: ReadonlyArray<Message> = MESSAGES,
): Promise<TurnResult> {
  const req: TurnRequest = {
    step_index: 0,
    messages,
    tools: [weather_tool],
    abort: new AbortController().signal,
    stream,
    model_id,
    effort: 'none',
    ...(stream ? { dispatch_chunk: async (_chunk: StreamChunk) => {} } : {}),
  }
  return adapter.invoke_turn(req)
}

/** Drive one ai_sdk turn, which streams whether or not a consumer is attached. */
async function run_ai_sdk_turn(
  adapter: AiSdkProviderAdapter,
  model_id: string,
  messages: ReadonlyArray<Message> = MESSAGES,
): Promise<TurnResult> {
  const turn = create_ai_sdk_turn({
    adapter,
    model_id,
    dispatcher: create_chunk_dispatcher(undefined),
    tools: [weather_tool],
    schema: undefined,
    provider_options: undefined,
    temperature: undefined,
    max_tokens: undefined,
    top_p: undefined,
    reasoning: undefined,
    telemetry: undefined,
  })
  return turn({
    step_index: 0,
    messages,
    abort: new AbortController().signal,
    on_first_chunk: () => {},
  })
}

type CaseFixtures = {
  readonly json: () => Response
  readonly sse: () => Response
  readonly golden: TurnResult
}

type ParitySpec = {
  readonly label: string
  readonly model_id: string
  readonly native: NativeProviderAdapter
  readonly ai_sdk: AiSdkProviderAdapter
  readonly text: CaseFixtures
  readonly tool: CaseFixtures
  /** The key the SDK's providerMetadata uses for this provider. */
  readonly reported_key: string
}

/**
 * Drop `provider_reported` from a TurnResult, leaving the neutral fields both
 * transports must map identically.
 *
 * `provider_reported` is deliberately outside the golden: it carries the AI
 * SDK's own providerMetadata verbatim, whose keys are the peer's synthesis
 * (anthropic reports `container`, `iterations`, `contextManagement`) rather
 * than fields on the wire. A native mapper reproducing that would be copying a
 * peer's choices instead of reading the response, so the two transports are
 * pinned separately below.
 */
function neutral(result: TurnResult): Omit<TurnResult, 'provider_reported'> {
  const { provider_reported: _reported, ...rest } = result
  return rest
}

function declare_parity_suite(make_spec: () => ParitySpec): void {
  const spec = make_spec()
  describe(`transport parity: ${spec.label}`, () => {
    const cases: ReadonlyArray<readonly [string, CaseFixtures]> = [
      ['text turn', spec.text],
      ['tool-call turn', spec.tool],
    ]
    for (const [case_label, fixtures] of cases) {
      it(`${case_label}: ai_sdk (streamed) and native (whole and streamed) agree with the golden`, async () => {
        stub_fetch(fixtures.json)
        const native_ns = await run_native_turn(spec.native, spec.model_id, false)
        stub_fetch(fixtures.sse)
        const native_s = await run_native_turn(spec.native, spec.model_id, true)
        stub_fetch(fixtures.sse)
        const ai_sdk_s = await run_ai_sdk_turn(spec.ai_sdk, spec.model_id)

        expect(neutral(native_ns), 'native non-streamed').toEqual(fixtures.golden)
        expect(neutral(native_s), 'native streamed').toEqual(fixtures.golden)
        expect(neutral(ai_sdk_s), 'ai_sdk streamed').toEqual(fixtures.golden)

        // The SDK keys its metadata by provider name, which is what lets
        // provider_reported ride through untranslated, read here off the
        // real peer's streamed finish-step rather than a mocked one.
        expect(ai_sdk_s.provider_reported, 'ai_sdk streamed').toHaveProperty(spec.reported_key)

        // The native mappers report nothing: they read the wire, not the SDK's
        // synthesized metadata. Asserted so the asymmetry stays deliberate.
        expect(native_ns.provider_reported, 'native non-streamed').toBeUndefined()
        expect(native_s.provider_reported, 'native streamed').toBeUndefined()
      })
    }
  })
}

// ---------------------------------------------------------------------------
// OpenAI fixtures (chat/completions wire, shared by native + the SDK chat model)
// ---------------------------------------------------------------------------

const OPENAI_MODEL = 'gpt-parity'

const OPENAI_TEXT_USAGE = {
  prompt_tokens: 1300,
  completion_tokens: 550,
  total_tokens: 1850,
  prompt_tokens_details: { cached_tokens: 1000 },
  completion_tokens_details: { reasoning_tokens: 150 },
}

const OPENAI_TEXT_JSON = {
  id: 'chatcmpl-parity-text',
  object: 'chat.completion',
  model: OPENAI_MODEL,
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hello from OpenAI.' }, finish_reason: 'stop' },
  ],
  usage: OPENAI_TEXT_USAGE,
}

const OPENAI_TEXT_SSE: Array<Record<string, unknown> | '[DONE]'> = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  { choices: [{ index: 0, delta: { content: 'Hello ' } }] },
  { choices: [{ index: 0, delta: { content: 'from OpenAI.' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: OPENAI_TEXT_USAGE },
  '[DONE]',
]

const OPENAI_TOOL_USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 500,
  total_tokens: 1500,
  prompt_tokens_details: { cached_tokens: 800 },
  completion_tokens_details: { reasoning_tokens: 60 },
}

const OPENAI_TOOL_JSON = {
  id: 'chatcmpl-parity-tool',
  object: 'chat.completion',
  model: OPENAI_MODEL,
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
  usage: OPENAI_TOOL_USAGE,
}

const OPENAI_TOOL_SSE: Array<Record<string, unknown> | '[DONE]'> = [
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
  { choices: [], usage: OPENAI_TOOL_USAGE },
  '[DONE]',
]

function openai_native_adapter(): NativeProviderAdapter {
  return as_native(create_openai_adapter({ transport: 'native', api_key: 'sk-test' }))
}

/**
 * The ai_sdk leg for openai: a real @ai-sdk/openai CHAT model (wire-compatible
 * with the native chat/completions transport) behind the engine's real
 * normalize_openai_usage / translate_effort_to_sdk_reasoning. Only the
 * endpoint choice differs from the production ai_sdk openai adapter (which
 * defaults to the Responses API); the usage/finish-reason normalization under
 * test is identical.
 */
function openai_ai_sdk_adapter(): AiSdkProviderAdapter {
  return {
    kind: 'ai_sdk',
    name: 'openai',
    build_model: async (model_id: string) => createOpenAI({ apiKey: 'sk-test' }).chat(model_id),
    translate_effort: translate_effort_to_sdk_reasoning,
    normalize_usage: normalize_openai_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}

declare_parity_suite(() => ({
  label: 'openai (chat/completions)',
  model_id: OPENAI_MODEL,
  native: openai_native_adapter(),
  ai_sdk: openai_ai_sdk_adapter(),
  reported_key: 'openai',
  text: {
    json: json_factory(OPENAI_TEXT_JSON),
    sse: sse_factory(openai_sse(OPENAI_TEXT_SSE)),
    golden: {
      text: 'Hello from OpenAI.',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 1300, output_tokens: 550, cached_input_tokens: 1000, reasoning_tokens: 150 },
    },
  },
  tool: {
    json: json_factory(OPENAI_TOOL_JSON),
    sse: sse_factory(openai_sse(OPENAI_TOOL_SSE)),
    golden: {
      text: '',
      tool_calls: [{ id: 'call_01', name: 'get_weather', input: { city: 'Ottawa' } }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 800, reasoning_tokens: 60 },
    },
  },
}))

// ---------------------------------------------------------------------------
// Anthropic fixtures (Messages wire, shared verbatim by native + @ai-sdk/anthropic)
// ---------------------------------------------------------------------------

const ANTHROPIC_MODEL = 'claude-parity'

const ANTHROPIC_TEXT_JSON = {
  id: 'msg-parity-text',
  type: 'message',
  role: 'assistant',
  model: ANTHROPIC_MODEL,
  content: [{ type: 'text', text: 'Hello from Anthropic.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 1300,
    output_tokens: 550,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 200,
  },
}

const ANTHROPIC_TEXT_SSE: Array<Record<string, unknown>> = [
  {
    type: 'message_start',
    message: {
      id: 'msg-parity-text',
      type: 'message',
      role: 'assistant',
      model: ANTHROPIC_MODEL,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 1300,
        output_tokens: 2,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'from Anthropic.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 550 } },
  { type: 'message_stop' },
]

const ANTHROPIC_TOOL_JSON = {
  id: 'msg-parity-tool',
  type: 'message',
  role: 'assistant',
  model: ANTHROPIC_MODEL,
  content: [{ type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } }],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 100,
  },
}

const ANTHROPIC_TOOL_SSE: Array<Record<string, unknown>> = [
  {
    type: 'message_start',
    message: {
      id: 'msg-parity-tool',
      type: 'message',
      role: 'assistant',
      model: ANTHROPIC_MODEL,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 1000,
        output_tokens: 2,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 100,
      },
    },
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

declare_parity_suite(() => ({
  label: 'anthropic (messages)',
  model_id: ANTHROPIC_MODEL,
  native: as_native(create_anthropic_adapter({ api_key: 'sk-test', transport: 'native' })),
  ai_sdk: as_ai_sdk(create_anthropic_adapter({ api_key: 'sk-test' })),
  reported_key: 'anthropic',
  text: {
    json: json_factory(ANTHROPIC_TEXT_JSON),
    sse: sse_factory(anthropic_sse(ANTHROPIC_TEXT_SSE)),
    // input_tokens is inclusive of cache (1300 + 1000 read + 200 write = 2500)
    // on both transports; the ai_sdk anthropic provider reports the same
    // inclusive total the native mapper computes.
    golden: {
      text: 'Hello from Anthropic.',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 2500, output_tokens: 550, cached_input_tokens: 1000, cache_write_tokens: 200 },
    },
  },
  tool: {
    json: json_factory(ANTHROPIC_TOOL_JSON),
    sse: sse_factory(anthropic_sse(ANTHROPIC_TOOL_SSE)),
    golden: {
      text: '',
      tool_calls: [{ id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 1900, output_tokens: 500, cached_input_tokens: 800, cache_write_tokens: 100 },
    },
  },
}))

// ---------------------------------------------------------------------------
// Documented normalization divergence (the drift the golden suite guards)
// ---------------------------------------------------------------------------

describe('transport parity: known usage-normalization divergence', () => {
  it('ai_sdk reports zero-valued granular usage that native omits when the wire carries no cache/reasoning detail', async () => {
    const bare = {
      id: 'chatcmpl-bare',
      object: 'chat.completion',
      model: OPENAI_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'no details' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }
    const native = openai_native_adapter()
    const ai_sdk = openai_ai_sdk_adapter()

    stub_fetch(json_factory(bare))
    const native_result = await run_native_turn(native, OPENAI_MODEL, false)
    stub_fetch(
      sse_factory(
        openai_sse([
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'no details' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: bare.usage },
          '[DONE]',
        ]),
      ),
    )
    const ai_sdk_result = await run_ai_sdk_turn(ai_sdk, OPENAI_MODEL)

    // Core totals agree; the ai_sdk leg additionally surfaces zero-valued cache
    // and reasoning fields the native mapper leaves absent. The difference is
    // cost-neutral: compute_cost reads every granular field as `?? 0`, so absent
    // and zero price identically. Pinned here so a future SDK or mapper change
    // that widens this gap is caught rather than shipped silently.
    expect(native_result.usage).toEqual({ input_tokens: 100, output_tokens: 50 })
    expect(ai_sdk_result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
    })
    expect(ai_sdk_result.text).toBe(native_result.text)
    expect(ai_sdk_result.finish_reason).toBe(native_result.finish_reason)
  })
})

// ---------------------------------------------------------------------------
// A fed-back error on both Anthropic wires
// ---------------------------------------------------------------------------

describe('transport parity: a fed-back tool error', () => {
  const FED_BACK: ReadonlyArray<Message> = [
    { role: 'user', content: 'weather in Ottawa and Kingston?' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_call', id: 'toolu_01', name: 'get_weather', input: { city: 'Ottawa' } },
        { type: 'tool_call', id: 'toolu_02', name: 'get_weather', input: { city: 'Kingston' } },
      ],
    },
    { role: 'tool', tool_call_id: 'toolu_01', name: 'get_weather', content: 'sunny' },
    {
      role: 'tool',
      tool_call_id: 'toolu_02',
      name: 'get_weather',
      content: '{"error":"tool_approval_denied"}',
      is_error: true,
    },
  ]

  /** Serve the recorded SSE turn and keep each request's parsed body. */
  function capture_bodies(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = []
    const respond = sse_factory(anthropic_sse(ANTHROPIC_TEXT_SSE))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>)
        return respond()
      }),
    )
    return bodies
  }

  /** The tool_result blocks of the last user message a body sent. */
  function tool_results(body: Record<string, unknown> | undefined): unknown {
    const messages = body?.['messages'] as Array<{ role: string; content: unknown }> | undefined
    const last = messages?.at(-1)?.content as Array<Record<string, unknown>> | undefined
    return last?.filter((block) => block['type'] === 'tool_result')
  }

  it('reaches the Messages API as is_error: true from the native adapter and from @ai-sdk/anthropic', async () => {
    const bodies = capture_bodies()
    await run_native_turn(
      as_native(create_anthropic_adapter({ api_key: 'sk-test', transport: 'native' })),
      ANTHROPIC_MODEL,
      true,
      FED_BACK,
    )
    await run_ai_sdk_turn(as_ai_sdk(create_anthropic_adapter({ api_key: 'sk-test' })), ANTHROPIC_MODEL, FED_BACK)
    expect(bodies).toHaveLength(2)

    expect(tool_results(bodies[0]), 'native').toStrictEqual([
      { type: 'tool_result', tool_use_id: 'toolu_01', content: 'sunny' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_02',
        content: '{"error":"tool_approval_denied"}',
        is_error: true,
      },
    ])
    expect(tool_results(bodies[1]), 'ai_sdk').toStrictEqual([
      { type: 'tool_result', tool_use_id: 'toolu_01', content: 'sunny' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_02',
        content: '{"error":"tool_approval_denied"}',
        is_error: true,
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// A cut-off stream and a failed turn on the ai_sdk transport, through the
// real @ai-sdk/anthropic peer
// ---------------------------------------------------------------------------

describe('ai_sdk anthropic: a stream cut off before the step finished', () => {
  const NO_WAIT = { max_attempts: 3, initial_delay_ms: 0, max_delay_ms: 0, retry_on: ['network' as const] }
  // The text stream up to its last delta: no message_delta, no message_stop.
  const CUT = ANTHROPIC_TEXT_SSE.slice(0, 4)

  /** Serve each response in order, counting the requests. */
  function stub_queue(responses: Array<() => Response>): { calls: () => number } {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const next = responses[calls]
        calls += 1
        if (next === undefined) throw new Error('fetch queue exhausted')
        return next()
      }),
    )
    return { calls: () => calls }
  }

  const engine = (): ReturnType<typeof create_engine> =>
    create_engine({ providers: { anthropic: { api_key: 'sk-test' } } })

  it('retries the whole turn when nothing consumes the chunks, and fails as stream interrupted when something does', async () => {
    const quiet = stub_queue([sse_factory(anthropic_sse(CUT)), sse_factory(anthropic_sse(ANTHROPIC_TEXT_SSE))])
    const result = await engine().generate({ model: ANTHROPIC_MODEL, prompt: 'hi', retry: NO_WAIT })
    expect(result.content).toBe('Hello from Anthropic.')
    expect(quiet.calls()).toBe(2)

    vi.unstubAllGlobals()
    const watched = stub_queue([sse_factory(anthropic_sse(CUT)), sse_factory(anthropic_sse(ANTHROPIC_TEXT_SSE))])
    const caught = await engine()
      .generate({ model: ANTHROPIC_MODEL, prompt: 'hi', retry: NO_WAIT, on_chunk: () => {} })
      .catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(provider_error)
    expect((caught as Error).message).toBe(
      'stream interrupted: anthropic stream ended before the step finished; the result would be truncated',
    )
    expect(watched.calls()).toBe(1)
  })

  it('surfaces an exhausted cut-off stream as a network provider_error', async () => {
    stub_queue([1, 2, 3].map(() => sse_factory(anthropic_sse(CUT))))
    const caught = await engine()
      .generate({ model: ANTHROPIC_MODEL, prompt: 'hi', retry: NO_WAIT })
      .catch((e: unknown) => e)
    expect(caught).toMatchObject({
      cause_kind: 'network',
      message: 'anthropic stream ended before the step finished; the result would be truncated',
    })
  })

  it('writes nothing to console.error when a turn fails, consumer or not', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad_request = (): Response =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    try {
      for (const consumer of [false, true]) {
        vi.unstubAllGlobals()
        stub_queue([bad_request])
        const caught = await engine()
          .generate({ model: ANTHROPIC_MODEL, prompt: 'hi', retry: NO_WAIT, ...(consumer ? { on_chunk: () => {} } : {}) })
          .catch((e: unknown) => e)
        expect((caught as Error).message, `consumer: ${String(consumer)}`).toMatch(/bad/)
      }
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})
