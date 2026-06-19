import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { GenerateOptions, GenerateResult, Message, Tool } from '../types.js'
import {
  aggregate_cost,
  build_initial_messages,
  classify_ai_sdk_error,
  default_usage_from_sdk,
  map_finish_reason,
  map_stream_part_to_chunk,
  round6,
  split_leading_system,
  to_raw_provider_usage,
  to_sdk_messages,
  to_sdk_tools,
} from '../generate.js'

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
    expect(to_raw_provider_usage({ inputTokens: 5, outputTokens: 3 })).toEqual({
      input_tokens: 5,
      output_tokens: 3,
    })
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
})

describe('build_initial_messages', () => {
  const opts = (o: Partial<GenerateOptions>): GenerateOptions => o as GenerateOptions

  it('prepends a non-empty system message before a string prompt', () => {
    expect(build_initial_messages(opts({ system: 'be brief', prompt: 'hi' }))).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('omits an empty system message', () => {
    expect(build_initial_messages(opts({ system: '', prompt: 'hi' }))).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('copies an array prompt without aliasing', () => {
    const prompt: Message[] = [{ role: 'user', content: 'a' }]
    const out = build_initial_messages(opts({ prompt }))
    expect(out).toEqual(prompt)
    expect(out[0]).not.toBe(prompt[0])
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
    expect(to_sdk_messages(messages)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'search', output: { type: 'text', value: 'result' } }],
      },
      { role: 'assistant', content: 'reply' },
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
    expect(to_sdk_messages(messages)[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', image: 'data', mediaType: 'image/png' },
        { type: 'image', image: 'raw' },
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
    expect(to_sdk_messages(messages)[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking' },
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

describe('map_stream_part_to_chunk', () => {
  const m = (part: Record<string, unknown>) =>
    map_stream_part_to_chunk(part as never, 2)

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

  it('returns undefined for an unknown part type', () => {
    expect(m({ type: 'something-else' })).toBeUndefined()
  })
})

describe('classify_ai_sdk_error', () => {
  it('passes through non-objects and every already-classified kind', () => {
    expect(classify_ai_sdk_error('boom')).toBe('boom')
    expect(classify_ai_sdk_error(null)).toBe(null)
    for (const kind of ['rate_limit', 'provider_5xx', 'network', 'timeout']) {
      const classified = { kind, status: 1 }
      expect(classify_ai_sdk_error(classified)).toBe(classified)
    }
  })

  it('classifies a 429 with no headers and omits absent message/retry_after', () => {
    const out = classify_ai_sdk_error({ statusCode: 429 }) as Record<string, unknown>
    expect(out).toEqual({ kind: 'rate_limit', status: 429 })
    expect('message' in out).toBe(false)
    expect('retry_after_ms' in out).toBe(false)
  })

  it('treats 500 and 599 as 5xx but not 600 or 499', () => {
    expect((classify_ai_sdk_error({ status: 500 }) as { kind?: string }).kind).toBe('provider_5xx')
    expect((classify_ai_sdk_error({ status: 599 }) as { kind?: string }).kind).toBe('provider_5xx')
    const at600 = { status: 600 }
    expect(classify_ai_sdk_error(at600)).toBe(at600) // not 5xx -> passthrough
    const at499 = { status: 499 }
    expect(classify_ai_sdk_error(at499)).toBe(at499)
  })

  it('classifies a 429 with Retry-After header into rate_limit', () => {
    const out = classify_ai_sdk_error({
      statusCode: 429,
      message: 'slow down',
      responseHeaders: { 'retry-after': '2' },
    }) as Record<string, unknown>
    expect(out).toMatchObject({ kind: 'rate_limit', status: 429, message: 'slow down', retry_after_ms: 2000 })
  })

  it('reads the alternate status field and classifies 5xx', () => {
    const out = classify_ai_sdk_error({ status: 503, message: 'unavailable' }) as Record<string, unknown>
    expect(out).toMatchObject({ kind: 'provider_5xx', status: 503, message: 'unavailable' })
  })

  it('classifies known network error codes', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED']) {
      const out = classify_ai_sdk_error({ code, message: 'net' }) as Record<string, unknown>
      expect(out).toMatchObject({ kind: 'network', message: 'net' })
    }
  })

  it('passes through an unclassifiable error object', () => {
    const err = { statusCode: 400, message: 'bad request' }
    expect(classify_ai_sdk_error(err)).toBe(err)
  })
})

describe('round6 and aggregate_cost', () => {
  it('rounds to six decimal places', () => {
    expect(round6(0.123456789)).toBe(0.123457)
  })

  const step = (cost: GenerateResult['steps'][number]['cost']): GenerateResult['steps'][number] =>
    ({ index: 0, text: '', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'stop', ...(cost !== undefined ? { cost } : {}) }) as GenerateResult['steps'][number]

  it('sums step costs including optional cached/cache_write/reasoning fields', () => {
    const out = aggregate_cost(
      [
        step({ total_usd: 0.1, input_usd: 0.06, output_usd: 0.04, currency: 'USD', is_estimate: true, cached_input_usd: 0.01, cache_write_usd: 0.005, reasoning_usd: 0.02 }),
        step({ total_usd: 0.2, input_usd: 0.12, output_usd: 0.08, currency: 'USD', is_estimate: true, cached_input_usd: 0.03 }),
      ],
      'anthropic',
    )
    expect(out).toMatchObject({
      total_usd: 0.3,
      input_usd: 0.18,
      output_usd: 0.12,
      currency: 'USD',
      cached_input_usd: 0.04,
      cache_write_usd: 0.005,
      reasoning_usd: 0.02,
    })
  })

  it('omits optional cost fields no step reported', () => {
    const out = aggregate_cost([step({ total_usd: 0.1, input_usd: 0.06, output_usd: 0.04, currency: 'USD', is_estimate: true })], 'anthropic')
    expect('cached_input_usd' in (out ?? {})).toBe(false)
    expect('cache_write_usd' in (out ?? {})).toBe(false)
    expect('reasoning_usd' in (out ?? {})).toBe(false)
  })

  it('returns undefined when no step has a cost and the provider is paid', () => {
    expect(aggregate_cost([step(undefined)], 'anthropic')).toBeUndefined()
  })

  it('returns a zero USD estimate for a free provider with steps but no cost', () => {
    expect(aggregate_cost([step(undefined)], 'ollama')).toMatchObject({
      total_usd: 0,
      currency: 'USD',
      is_estimate: true,
    })
  })

  it('returns undefined for a free provider with no steps at all', () => {
    expect(aggregate_cost([], 'ollama')).toBeUndefined()
  })
})
