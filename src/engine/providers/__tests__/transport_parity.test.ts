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
 * Wire sharing per provider:
 *   - anthropic: one Messages-API (`/v1/messages`) fixture feeds both legs; the
 *     native adapter and @ai-sdk/anthropic both speak that wire, so this is
 *     literally the same recorded bytes through two transports.
 *   - openai: the native transport speaks `/chat/completions` while
 *     @ai-sdk/openai's default model is the Responses API. To drive ONE recorded
 *     chat/completions request through both legs, the ai_sdk leg is pinned to
 *     the SDK's wire-compatible chat model (`createOpenAI(...).chat`). The
 *     normalization under test — normalize_openai_usage over the SDK's canonical
 *     usage shape — is identical regardless of which OpenAI endpoint produced it.
 *
 * No live network (C5): fetch is stubbed with recorded fixtures. Tests are
 * exempt from the native-import rules, so importing `ai` / `@ai-sdk/*` here is
 * allowed; production native modules stay SDK-free.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { create_anthropic_adapter } from '../anthropic.js'
import {
  create_openai_adapter,
  normalize_openai_usage,
  translate_openai_effort,
} from '../openai.js'
import { create_ai_sdk_turn } from '../ai_sdk/invoke.js'
import { create_chunk_dispatcher } from '../../streaming.js'
import type {
  AiSdkProviderAdapter,
  NativeProviderAdapter,
  ProviderAdapter,
  ProviderCapability,
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
): Promise<TurnResult> {
  const req: TurnRequest = {
    step_index: 0,
    messages: MESSAGES,
    tools: [weather_tool],
    abort: new AbortController().signal,
    stream,
    model_id,
    effort: 'none',
    ...(stream ? { dispatch_chunk: async (_chunk: StreamChunk) => {} } : {}),
  }
  return adapter.invoke_turn(req)
}

async function run_ai_sdk_turn(
  adapter: AiSdkProviderAdapter,
  model_id: string,
  stream: boolean,
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
  })
  return turn({
    step_index: 0,
    messages: MESSAGES,
    abort: new AbortController().signal,
    stream,
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
}

function declare_parity_suite(make_spec: () => ParitySpec): void {
  const spec = make_spec()
  describe(`transport parity: ${spec.label}`, () => {
    const cases: ReadonlyArray<readonly [string, CaseFixtures]> = [
      ['text turn', spec.text],
      ['tool-call turn', spec.tool],
    ]
    for (const [case_label, fixtures] of cases) {
      it(`${case_label}: ai_sdk and native agree with the golden, streamed and non-streamed`, async () => {
        stub_fetch(fixtures.json)
        const native_ns = await run_native_turn(spec.native, spec.model_id, false)
        stub_fetch(fixtures.json)
        const ai_sdk_ns = await run_ai_sdk_turn(spec.ai_sdk, spec.model_id, false)
        stub_fetch(fixtures.sse)
        const native_s = await run_native_turn(spec.native, spec.model_id, true)
        stub_fetch(fixtures.sse)
        const ai_sdk_s = await run_ai_sdk_turn(spec.ai_sdk, spec.model_id, true)

        expect(native_ns, 'native non-streamed').toEqual(fixtures.golden)
        expect(ai_sdk_ns, 'ai_sdk non-streamed').toEqual(fixtures.golden)
        expect(native_s, 'native streamed').toEqual(fixtures.golden)
        expect(ai_sdk_s, 'ai_sdk streamed').toEqual(fixtures.golden)
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
 * normalize_openai_usage / translate_openai_effort. Only the endpoint choice
 * differs from the production ai_sdk openai adapter (which defaults to the
 * Responses API); the usage/finish-reason normalization under test is identical.
 */
function openai_ai_sdk_adapter(): AiSdkProviderAdapter {
  return {
    kind: 'ai_sdk',
    name: 'openai',
    build_model: async (model_id: string) => createOpenAI({ apiKey: 'sk-test' }).chat(model_id),
    translate_effort: translate_openai_effort,
    normalize_usage: normalize_openai_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}

declare_parity_suite(() => ({
  label: 'openai (chat/completions)',
  model_id: OPENAI_MODEL,
  native: openai_native_adapter(),
  ai_sdk: openai_ai_sdk_adapter(),
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
    stub_fetch(json_factory(bare))
    const ai_sdk_result = await run_ai_sdk_turn(ai_sdk, OPENAI_MODEL, false)

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
