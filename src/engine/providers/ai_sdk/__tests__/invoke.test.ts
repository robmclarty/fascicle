import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Message, Tool } from '../../../types.js'
import {
  default_usage_from_sdk,
  map_finish_reason,
  map_stream_part_to_chunk,
  split_leading_system,
  to_raw_provider_usage,
  to_sdk_messages,
  to_sdk_tools,
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
