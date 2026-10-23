import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { create_engine } from '../../../create_engine.js'
import { create_chunk_dispatcher } from '../../../streaming.js'
import type { Message, Tool } from '../../../types.js'
import { default_normalize_usage, type AiSdkProviderAdapter } from '../../types.js'
import {
  create_ai_sdk_turn,
  default_usage_from_sdk,
  map_finish_reason,
  map_stream_part_to_chunk,
  split_leading_system,
  to_provider_reported,
  to_raw_provider_usage,
  to_sdk_messages,
  to_sdk_tools,
  to_turn_content,
} from '../invoke.js'

describe('map_finish_reason', () => {
  it('maps known reasons and defaults unknowns to stop', () => {
    expect(map_finish_reason('stop')).toBe('stop')
    expect(map_finish_reason('length')).toBe('length')
    expect(map_finish_reason('content-filter')).toBe('content_filter')
    expect(map_finish_reason('content_filter')).toBe('content_filter')
    expect(map_finish_reason('tool-calls')).toBe('tool_calls')
    expect(map_finish_reason('tool_calls')).toBe('tool_calls')
    expect(map_finish_reason(undefined)).toBe('stop')
    expect(map_finish_reason('weird')).toBe('stop')
  })
})

describe('to_raw_provider_usage', () => {
  it('returns {} for null or non-object input', () => {
    expect(to_raw_provider_usage(null)).toEqual({})
    expect(to_raw_provider_usage(42)).toEqual({})
  })

  it('reads camelCase SDK token fields and nested details', () => {
    expect(
      to_raw_provider_usage({
        inputTokens: 10,
        outputTokens: 5,
        inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 2 },
        outputTokenDetails: { reasoningTokens: 1 },
      }),
    ).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      input_token_details: { cached_tokens: 3, cache_creation_input_tokens: 2 },
      output_token_details: { reasoning_tokens: 1 },
    })
  })

  it('passes through flattened snake_case fields', () => {
    expect(
      to_raw_provider_usage({
        input_tokens: 7,
        output_tokens: 4,
        cached_input_tokens: 2,
        cache_write_tokens: 1,
        reasoning_tokens: 6,
      }),
    ).toEqual({
      input_tokens: 7,
      output_tokens: 4,
      cached_input_tokens: 2,
      cache_write_tokens: 1,
      reasoning_tokens: 6,
    })
  })

  it('prefers camelCase over the flat fallback for input/output tokens', () => {
    const raw = to_raw_provider_usage({ inputTokens: 10, input_tokens: 99, outputTokens: 5, output_tokens: 88 })
    expect(raw.input_tokens).toBe(10)
    expect(raw.output_tokens).toBe(5)
  })

  it('ignores non-numeric token fields', () => {
    expect(to_raw_provider_usage({ inputTokens: 'x', outputTokens: null })).toEqual({})
  })

  it('adds no detail or flat keys when only the camelCase totals are present', () => {
    expect(to_raw_provider_usage({ inputTokens: 5, outputTokens: 3 })).toStrictEqual({
      input_tokens: 5,
      output_tokens: 3,
    })
  })

  it('skips detail blocks when the detail field is null', () => {
    expect(
      to_raw_provider_usage({
        inputTokens: 1,
        outputTokens: 1,
        inputTokenDetails: null,
        outputTokenDetails: null,
      }),
    ).toStrictEqual({ input_tokens: 1, output_tokens: 1 })
  })

  it('ignores non-numeric flat token fields', () => {
    expect(to_raw_provider_usage({ input_tokens: 'x', output_tokens: 'y' })).toStrictEqual({})
  })

  it('keeps detail objects but omits non-numeric nested fields', () => {
    expect(
      to_raw_provider_usage({
        inputTokens: 1,
        outputTokens: 1,
        inputTokenDetails: { cacheReadTokens: 'x', cacheWriteTokens: null },
        outputTokenDetails: { reasoningTokens: 'y' },
      }),
    ).toEqual({
      input_tokens: 1,
      output_tokens: 1,
      input_token_details: {},
      output_token_details: {},
    })
  })
})

describe('default_usage_from_sdk', () => {
  it('fills missing input/output with zero', () => {
    expect(default_usage_from_sdk(undefined)).toMatchObject({ input_tokens: 0, output_tokens: 0 })
    expect(default_usage_from_sdk({ inputTokens: 3 })).toMatchObject({ input_tokens: 3, output_tokens: 0 })
  })

  it('carries cache and reasoning granularity through from the v7 nested shape', () => {
    expect(
      default_usage_from_sdk({
        inputTokens: 1300,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 200 },
        outputTokens: 550,
        outputTokenDetails: { textTokens: 400, reasoningTokens: 150 },
        totalTokens: 1850,
      }),
    ).toStrictEqual({
      input_tokens: 1300,
      output_tokens: 550,
      reasoning_tokens: 150,
      cached_input_tokens: 1000,
      cache_write_tokens: 200,
    })
  })

  it('omits granular fields when the nested details are absent', () => {
    expect(default_usage_from_sdk({ inputTokens: 5, outputTokens: 3 })).toStrictEqual({
      input_tokens: 5,
      output_tokens: 3,
    })
  })
})

describe('to_provider_reported', () => {
  it('returns undefined for a provider that reported nothing', () => {
    expect(to_provider_reported(undefined)).toBeUndefined()
    expect(to_provider_reported(null)).toBeUndefined()
    expect(to_provider_reported('trace')).toBeUndefined()
    expect(to_provider_reported({})).toBeUndefined()
  })

  it('keeps the SDK provider keys and payloads untranslated', () => {
    const trace = { guardrail: { inputAssessment: { pii: ['EMAIL'] } } }
    expect(to_provider_reported({ amazonBedrock: { trace }, bedrock: { trace } })).toStrictEqual({
      amazonBedrock: { trace },
      bedrock: { trace },
    })
  })

  it('copies the top level without cloning the opaque payload', () => {
    const payload = { trace: { guardrail: {} } }
    const metadata = { bedrock: payload }
    const reported = to_provider_reported(metadata)
    expect(reported).not.toBe(metadata)
    expect(reported?.['bedrock']).toBe(payload)
  })

  it('keeps a reported key whose value is falsy or empty', () => {
    expect(to_provider_reported({ openai: {}, anthropic: null })).toStrictEqual({
      openai: {},
      anthropic: null,
    })
  })
})

describe('to_sdk_messages', () => {
  it('maps system/user/tool/assistant roles to SDK shapes', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 't1', name: 'search', content: 'result' },
      { role: 'assistant', content: 'reply' },
    ]
    expect(to_sdk_messages(messages, 'anthropic')).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'search', output: { type: 'text', value: 'result' } }],
      },
      { role: 'assistant', content: 'reply' },
    ])
  })

  it('sends a failed call\'s result as error-text and a success\'s as text', () => {
    const messages: Message[] = [
      { role: 'tool', tool_call_id: 't1', name: 'search', content: 'result' },
      {
        role: 'tool',
        tool_call_id: 't2',
        name: 'search',
        content: '{"error":"tool_approval_denied"}',
        is_error: true,
      },
    ]
    expect(to_sdk_messages(messages, 'anthropic')).toStrictEqual([
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'search', output: { type: 'text', value: 'result' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't2',
            toolName: 'search',
            output: { type: 'error-text', value: '{"error":"tool_approval_denied"}' },
          },
        ],
      },
    ])
  })

  it('maps user text and image parts (with optional mediaType)', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: 'data', media_type: 'image/png' },
          { type: 'image', image: 'raw' },
        ],
      },
    ]
    // Strict, so a part without provider_options gains no providerOptions key.
    expect(to_sdk_messages(messages, 'anthropic')[0]).toStrictEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', image: 'data', mediaType: 'image/png' },
        { type: 'image', image: 'raw' },
      ],
    })
  })

  it('carries a user part provider_options through as providerOptions', () => {
    const guard_query = { bedrock: { guardContent: true, guardContentQualifiers: ['query'] } }
    const guard_image = { bedrock: { guardContent: true } }
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'passages' },
          { type: 'text', text: 'question', provider_options: guard_query },
          { type: 'image', image: 'data', media_type: 'image/png', provider_options: guard_image },
        ],
      },
    ]
    expect(to_sdk_messages(messages, 'anthropic')[0]).toStrictEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'passages' },
        { type: 'text', text: 'question', providerOptions: guard_query },
        { type: 'image', image: 'data', mediaType: 'image/png', providerOptions: guard_image },
      ],
    })
  })

  it('maps assistant text and tool_call parts', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_call', id: 'c1', name: 'search', input: { q: 'x' } },
        ],
      },
    ]
    expect(to_sdk_messages(messages, 'anthropic')[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { q: 'x' } },
      ],
    })
  })

  it("gives each assistant part's provider_options back as providerOptions, in order", () => {
    const signature = { anthropic: { signature: 'sig' } }
    const thought = { google: { thoughtSignature: 'ts' } }
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'plan', provider_options: signature },
          { type: 'text', text: 'checking', provider_options: thought },
          { type: 'tool_call', id: 'c1', name: 'search', input: { q: 'x' }, provider_options: thought },
        ],
      },
    ]
    expect(to_sdk_messages(messages, 'anthropic')[0]).toStrictEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'plan', providerOptions: signature },
        { type: 'text', text: 'checking', providerOptions: thought },
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'search',
          input: { q: 'x' },
          providerOptions: thought,
        },
      ],
    })
  })

  // Only reasoning under
  // the adapter's metadata key goes back.
  it('leaves behind reasoning keyed for another package or carrying no data', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'plan', provider_options: { anthropic: { signature: 'sig' } } },
          { type: 'text', text: 'checking' },
          { type: 'reasoning', text: '' },
          { type: 'tool_call', id: 'c1', name: 'search', input: { q: 'x' } },
        ],
      },
    ]
    expect(to_sdk_messages(messages, 'google')[0]).toStrictEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { q: 'x' } },
      ],
    })
  })
})

const sys = (content: string) => ({ role: 'system' as const, content })
const user = (content: string) => ({ role: 'user' as const, content })

describe('split_leading_system', () => {
  it('hoists a leading run of system messages into the system option', () => {
    const out = split_leading_system([sys('a'), sys('b'), user('hi')])
    expect(out.system).toBe('a\n\nb')
    expect(out.messages).toEqual([user('hi')])
  })

  it('returns the list unchanged when there is no leading system message', () => {
    const msgs = [user('hi'), sys('late')]
    const out = split_leading_system(msgs)
    expect(out.system).toBeUndefined()
    expect(out.messages).toEqual(msgs)
  })

  it('does not hoist when every message is a system message (would leave none)', () => {
    const out = split_leading_system([sys('a'), sys('b')])
    expect(out.system).toBeUndefined()
    expect(out.messages).toHaveLength(2)
  })
})

describe('to_sdk_tools', () => {
  it('returns undefined for an empty tool list', () => {
    expect(to_sdk_tools([])).toBeUndefined()
  })

  it('keys entries by tool name', () => {
    const tools: Tool[] = [
      { name: 'search', description: 'find', input_schema: z.object({ q: z.string() }), execute: () => null },
    ]
    const entries = to_sdk_tools(tools)
    expect(entries).toBeDefined()
    expect(Object.keys(entries ?? {})).toEqual(['search'])
  })
})

const m = (part: Record<string, unknown>) =>
  map_stream_part_to_chunk(part as never, 2)

describe('map_stream_part_to_chunk', () => {
  it('maps each known stream part type', () => {
    expect(m({ type: 'text-delta', text: 'hi' })).toEqual({ kind: 'text', text: 'hi', step_index: 2 })
    expect(m({ type: 'reasoning-delta', text: 'why' })).toEqual({ kind: 'reasoning', text: 'why', step_index: 2 })
    expect(m({ type: 'tool-input-start', id: 'c1', toolName: 'search' })).toEqual({
      kind: 'tool_call_start',
      id: 'c1',
      name: 'search',
      step_index: 2,
    })
    expect(m({ type: 'tool-input-delta', id: 'c1', delta: '{' })).toEqual({
      kind: 'tool_call_input_delta',
      id: 'c1',
      delta: '{',
      step_index: 2,
    })
    expect(m({ type: 'tool-call', toolCallId: 'c1', input: { q: 'x' } })).toEqual({
      kind: 'tool_call_end',
      id: 'c1',
      input: { q: 'x' },
      step_index: 2,
    })
    expect(m({ type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } })).toMatchObject({
      kind: 'step_finish',
      step_index: 2,
      finish_reason: 'stop',
    })
  })

  it('maps finish-step usage from the v7 nested shape with concrete granular values', () => {
    expect(
      m({
        type: 'finish-step',
        finishReason: 'tool-calls',
        usage: {
          inputTokens: 800,
          inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 600, cacheWriteTokens: undefined },
          outputTokens: 400,
          outputTokenDetails: { textTokens: 250, reasoningTokens: 150 },
          totalTokens: 1200,
        },
      }),
    ).toStrictEqual({
      kind: 'step_finish',
      step_index: 2,
      finish_reason: 'tool_calls',
      usage: {
        input_tokens: 800,
        output_tokens: 400,
        reasoning_tokens: 150,
        cached_input_tokens: 600,
      },
    })
  })

  it('returns undefined for an unknown part type', () => {
    expect(m({ type: 'something-else' })).toBeUndefined()
  })

  it('drops the v7 part kinds the engine chunk vocabulary does not model', () => {
    expect(m({ type: 'reasoning-file', file: { mediaType: 'image/png' } })).toBeUndefined()
    expect(m({ type: 'file', file: { mediaType: 'image/png' } })).toBeUndefined()
    expect(m({ type: 'source', sourceType: 'url', id: 's1', url: 'https://x' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The part-data round trip, on the real `ai` module with the
// SDK's own mock language model: each part's providerMetadata reaches
// TurnResult.content, and the next request gives it back as providerOptions,
// in order, with a chunk consumer and without one. Every turn streams, so the
// mock model offers doStream alone.
// ---------------------------------------------------------------------------

// The mock model's own option types, so the fixtures below are checked
// against the V4 content and stream-part shapes the SDK reads.
type MockModelOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>
type MockStreamResult = Extract<NonNullable<MockModelOptions['doStream']>, readonly unknown[]>[number]
type MockStreamPart = MockStreamResult['stream'] extends ReadableStream<infer part> ? part : never

const USAGE_V4 = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

const SIGNATURE = { anthropic: { signature: 'sig_sdk' } }
const THOUGHT = { google: { thoughtSignature: 'ts_sdk' } }

const weather: Tool = {
  name: 'get_weather',
  description: 'Look up current weather for a city',
  input_schema: z.object({ city: z.string() }),
  execute: () => 'sunny',
}

const EXPECTED_CONTENT = [
  { type: 'reasoning', text: 'need the city', provider_options: SIGNATURE },
  { type: 'text', text: 'Checking.' },
  {
    type: 'tool_call',
    id: 'call_1',
    name: 'get_weather',
    input: { city: 'Ottawa' },
    provider_options: THOUGHT,
  },
]

function stream_of(parts: MockStreamPart[]): MockStreamResult {
  return { stream: simulateReadableStream({ chunks: parts }) }
}

const TOOL_TURN_STREAM: MockStreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'reasoning-start', id: 'r1' },
  { type: 'reasoning-delta', id: 'r1', delta: 'need ' },
  { type: 'reasoning-delta', id: 'r1', delta: 'the city' },
  { type: 'reasoning-end', id: 'r1', providerMetadata: SIGNATURE },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Checking.' },
  { type: 'text-end', id: 't1' },
  {
    type: 'tool-call',
    toolCallId: 'call_1',
    toolName: 'get_weather',
    input: '{"city":"Ottawa"}',
    providerMetadata: THOUGHT,
  },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE_V4 },
]

const FINAL_TURN_STREAM: MockStreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't2' },
  { type: 'text-delta', id: 't2', delta: 'Sunny.' },
  { type: 'text-end', id: 't2' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: USAGE_V4 },
]

/** An ai_sdk adapter over a mock model, named and keyed as a test needs. */
function mock_adapter(
  model: MockLanguageModelV4,
  name: string,
  metadata_key?: string,
): AiSdkProviderAdapter {
  return {
    kind: 'ai_sdk',
    name,
    ...(metadata_key !== undefined ? { metadata_key } : {}),
    build_model: async () => model,
    translate_effort: () => ({ provider_options: {}, effort_ignored: false }),
    normalize_usage: default_normalize_usage,
    supports: (capability) => capability !== 'structured_output',
  }
}

/** A mock model whose first turn is `first` and whose second answers. */
function two_turn_model(first: MockStreamPart[] = TOOL_TURN_STREAM): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: [stream_of(first), stream_of(FINAL_TURN_STREAM)] })
}

/** Run a two-turn tool loop through the engine and return the mock model. */
async function run_loop(
  model: MockLanguageModelV4,
  consumer: boolean,
  name: string,
  metadata_key?: string,
): Promise<MockLanguageModelV4> {
  const engine = create_engine({
    providers: { [name]: {} },
    custom_providers: { [name]: () => mock_adapter(model, name, metadata_key) },
  })
  await engine.generate({
    model: 'mock-model',
    prompt: 'weather in Ottawa?',
    tools: [weather],
    ...(consumer ? { on_chunk: () => {} } : {}),
  })
  return model
}

/** The assistant message the second request carried, as the model saw it. */
function second_assistant(model: MockLanguageModelV4): unknown {
  return model.doStreamCalls[1]?.prompt.find((message) => message.role === 'assistant')
}

describe('ai_sdk part data round trip', () => {
  it("builds TurnResult.content from a streamed step once it drains, with each part's metadata", async () => {
    const model = new MockLanguageModelV4({ doStream: [stream_of(TOOL_TURN_STREAM)] })
    const turn = create_ai_sdk_turn({
      adapter: mock_adapter(model, 'anthropic_mock', 'anthropic'),
      model_id: 'mock-model',
      dispatcher: create_chunk_dispatcher(undefined),
      tools: [weather],
      schema: undefined,
      provider_options: undefined,
      temperature: undefined,
      max_tokens: undefined,
      top_p: undefined,
      reasoning: undefined,
      telemetry: undefined,
    })
    const result = await turn({
      step_index: 0,
      messages: [{ role: 'user', content: 'weather in Ottawa?' }],
      abort: new AbortController().signal,
      on_first_chunk: () => {},
    })
    expect(result.content).toStrictEqual(EXPECTED_CONTENT)
  })

  it.each([false, true])(
    'gives every part its data back on the next request, in order (consumer: %s)',
    async (consumer) => {
      const model = two_turn_model()
      await run_loop(model, consumer, 'anthropic_mock', 'anthropic')
      expect(model.doGenerateCalls).toStrictEqual([])
      expect(second_assistant(model)).toMatchObject({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need the city', providerOptions: SIGNATURE },
          { type: 'text', text: 'Checking.' },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', providerOptions: THOUGHT },
        ],
      })
    },
  )

  // A custom provider can't take a built-in name,
  // so a custom adapter over @ai-sdk/anthropic names its package's key.
  it('keeps the reasoning of a custom adapter named apart from its metadata_key', async () => {
    const keyed = await run_loop(two_turn_model(), false, 'vertex_claude', 'anthropic')
    expect(second_assistant(keyed)).toMatchObject({
      content: [{ type: 'reasoning', text: 'need the city', providerOptions: SIGNATURE }, {}, {}],
    })

    // Without the key, the adapter's name is the key, and the anthropic-keyed
    // reasoning stays behind.
    const unkeyed = await run_loop(two_turn_model(), false, 'vertex_claude')
    const content = (second_assistant(unkeyed) as { content: Array<{ type: string }> }).content
    expect(content.map((part) => part.type)).toStrictEqual(['text', 'tool-call'])
  })

  // Responses parts carry their itemIds back,
  // which @ai-sdk/openai sends as item references while `store` is on.
  it("sends a Responses turn's itemIds back as providerOptions", async () => {
    const item = (id: string) => ({ openai: { itemId: id } })
    const model = two_turn_model([
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'rs_1' },
      { type: 'reasoning-end', id: 'rs_1', providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' } } },
      { type: 'text-start', id: 'msg_1' },
      { type: 'text-delta', id: 'msg_1', delta: 'Checking.' },
      { type: 'text-end', id: 'msg_1', providerMetadata: item('msg_1') },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: '{"city":"Ottawa"}', providerMetadata: item('fc_1') },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: USAGE_V4 },
    ])
    await run_loop(model, false, 'openai_mock', 'openai')
    expect(second_assistant(model)).toMatchObject({
      content: [
        { type: 'reasoning', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' } } },
        { type: 'text', providerOptions: item('msg_1') },
        { type: 'tool-call', providerOptions: item('fc_1') },
      ],
    })
  })

  it('keeps content for a turn whose only data rides on a tool call', () => {
    expect(
      to_turn_content([
        { type: 'text', text: 'hi' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'get_weather',
          input: { city: 'Ottawa' },
          providerMetadata: THOUGHT,
        },
      ]),
    ).toStrictEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_call', id: 'call_1', name: 'get_weather', input: { city: 'Ottawa' }, provider_options: THOUGHT },
    ])
  })

  // A turn with nothing to send back has no
  // content key at all, streamed and not.
  it.each([false, true])('leaves the content key off a plain turn (consumer: %s)', async (consumer) => {
    const model = new MockLanguageModelV4({ doStream: [stream_of(FINAL_TURN_STREAM)] })
    const turn = create_ai_sdk_turn({
      adapter: mock_adapter(model, 'anthropic_mock', 'anthropic'),
      model_id: 'mock-model',
      dispatcher: create_chunk_dispatcher(consumer ? () => {} : undefined),
      tools: [],
      schema: undefined,
      provider_options: undefined,
      temperature: undefined,
      max_tokens: undefined,
      top_p: undefined,
      reasoning: undefined,
      telemetry: undefined,
    })
    const result = await turn({
      step_index: 0,
      messages: [{ role: 'user', content: 'hi' }],
      abort: new AbortController().signal,
      on_first_chunk: () => {},
    })
    expect(result.text).toBe('Sunny.')
    expect('content' in result).toBe(false)
  })

  it('leaves content off a turn whose parts carry no data, and drops sources', () => {
    expect(to_turn_content([{ type: 'text', text: 'hi' }])).toBeUndefined()
    expect(
      to_turn_content([
        { type: 'source', sourceType: 'url', id: 's1', url: 'https://example.com' },
        { type: 'text', text: 'hi', providerMetadata: {} },
      ]),
    ).toBeUndefined()
    expect(
      to_turn_content([
        { type: 'source', sourceType: 'url', id: 's1', url: 'https://example.com' },
        { type: 'reasoning', text: 'bare' },
        { type: 'text', text: 'hi' },
      ]),
    ).toStrictEqual([
      { type: 'reasoning', text: 'bare' },
      { type: 'text', text: 'hi' },
    ])
  })
})

// ---------------------------------------------------------------------------
// A failed call reaches the SDK's mock model as error-text, a denial included,
// so @ai-sdk/anthropic can flag it; a success stays text.
// ---------------------------------------------------------------------------

describe('ai_sdk fed-back tool errors', () => {
  const calls_turn: MockStreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'get_weather', input: '{"city":"Ottawa"}' },
    { type: 'tool-call', toolCallId: 'c2', toolName: 'missing', input: '{}' },
    { type: 'tool-call', toolCallId: 'c3', toolName: 'guarded', input: '{"city":"Ottawa"}' },
    { type: 'tool-call', toolCallId: 'c4', toolName: 'boom', input: '{"city":"Ottawa"}' },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE_V4 },
  ]

  it('sends every failure as error-text and a success as text', async () => {
    const model = new MockLanguageModelV4({
      doStream: [stream_of(calls_turn), stream_of(FINAL_TURN_STREAM)],
    })
    const engine = create_engine({
      providers: { anthropic_mock: {} },
      custom_providers: { anthropic_mock: () => mock_adapter(model, 'anthropic_mock', 'anthropic') },
    })
    const guarded: Tool = { ...weather, name: 'guarded', needs_approval: true }
    const boom: Tool = {
      ...weather,
      name: 'boom',
      execute: () => {
        throw new Error('kaput')
      },
    }
    await engine.generate({
      model: 'mock-model',
      prompt: 'weather in Ottawa?',
      tools: [weather, guarded, boom],
      on_tool_approval: () => false,
      on_chunk: () => {},
    })

    const outputs = model.doStreamCalls[1]?.prompt
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'tool-result' ? [part.toolCallId, part.output] : [part.type]))
    expect(outputs).toStrictEqual([
      ['c1', { type: 'text', value: 'sunny' }],
      ['c2', { type: 'error-text', value: `{"error":"unknown tool 'missing'"}` }],
      ['c3', { type: 'error-text', value: '{"error":"tool_approval_denied"}' }],
      ['c4', { type: 'error-text', value: '{"error":"kaput"}' }],
    ])
  })
})

describe('ai_sdk turns always stream', () => {
  it("streams with no on_chunk, even for an adapter whose supports('streaming') is false", async () => {
    const model = two_turn_model()
    const engine = create_engine({
      providers: { plain_mock: {} },
      custom_providers: {
        plain_mock: () => ({
          ...mock_adapter(model, 'plain_mock', 'anthropic'),
          supports: (capability) => capability !== 'streaming' && capability !== 'structured_output',
        }),
      },
    })
    const result = await engine.generate({ model: 'mock-model', prompt: 'weather in Ottawa?', tools: [weather] })
    expect(result.content).toBe('Sunny.')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(model.doGenerateCalls).toStrictEqual([])
    // The capability still gates on_chunk, so asking for chunks is refused.
    await expect(
      engine.generate({ model: 'mock-model', prompt: 'hi', on_chunk: () => {} }),
    ).rejects.toThrow(/streaming/)
  })
})

describe('ai_sdk structured output on a streamed turn', () => {
  /** A one-turn text stream. */
  const text_stream = (text: string): MockStreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE_V4 },
  ]

  it('hands a reply that misses the schema to the repair loop, since the SDK never parses it', async () => {
    const model = new MockLanguageModelV4({
      doStream: [stream_of(text_stream('not json at all')), stream_of(text_stream('{"n": 5}'))],
    })
    const engine = create_engine({
      providers: { local_mock: {} },
      custom_providers: {
        local_mock: () => ({ ...mock_adapter(model, 'local_mock'), supports: () => true }),
      },
    })
    const result = await engine.generate({ model: 'mock-model', prompt: 'n?', schema: z.object({ n: z.number() }) })
    expect(result.content).toStrictEqual({ n: 5 })
    expect(result.steps).toHaveLength(2)
    // The schema still reached the provider as its response format.
    expect(model.doStreamCalls[0]?.responseFormat).toMatchObject({ type: 'json' })
    expect(model.doGenerateCalls).toStrictEqual([])
  })
})

describe('to_sdk_messages and opaque parts', () => {
  it('sends no SDK part for an opaque part, which only its provider can read', () => {
    expect(
      to_sdk_messages(
        [
          {
            role: 'assistant',
            content: [
              { type: 'opaque', provider_options: { anthropic: { block: { type: 'server_tool_use', id: 'srv' } } } },
              { type: 'text', text: 'Hello.' },
            ],
          },
        ],
        'anthropic',
      ),
    ).toStrictEqual([{ role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }])
  })
})
