/**
 * Streaming parity.
 *
 * Every turn streams, so for the same mocked stream `generate` must return a
 * deeply equal GenerateResult whether `on_chunk` is supplied or omitted, and
 * that result is the one a whole-body reply of the same turn gave. This is the
 * invariant that lets composers stay unaware of streaming: they read the
 * result, and `on_chunk` is a pure observation seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  build_mock_ai_module,
  build_mock_registry_module,
  enqueue_stream,
  mock_state,
  reset_mock_state,
  type FakeStreamPart,
} from '../fixtures/mock_ai.js'

vi.mock('ai', async () => build_mock_ai_module())
vi.mock('../../providers/registry.js', async () => build_mock_registry_module())

import { create_engine } from '../../create_engine.js'
import type { GenerateResult, StreamChunk, Tool } from '../../types.js'

function strip_tc(tc: GenerateResult['tool_calls'][number]): Record<string, unknown> {
  return {
    id: tc.id,
    name: tc.name,
    input: tc.input,
    output: tc.output,
    error: tc.error,
  }
}

function normalize_result<t>(r: GenerateResult<t>): Record<string, unknown> {
  return {
    content: r.content,
    tool_calls: r.tool_calls.map(strip_tc),
    steps: r.steps.map((s) => ({
      index: s.index,
      text: s.text,
      usage: s.usage,
      finish_reason: s.finish_reason,
      cost: s.cost,
      tool_calls: s.tool_calls.map(strip_tc),
    })),
    usage: r.usage,
    finish_reason: r.finish_reason,
    model_resolved: r.model_resolved,
    cost: r.cost,
  }
}

beforeEach(() => reset_mock_state())
afterEach(() => reset_mock_state())

describe('streaming parity', () => {
  it('plain completion yields equal results with and without on_chunk', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    const parts: FakeStreamPart[] = [
      { type: 'text-delta', text: 'hello ' },
      { type: 'text-delta', text: 'world' },
      { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } },
    ]

    enqueue_stream(parts)
    const without = await engine.generate({ model: 'claude-opus', prompt: 'hi' })
    enqueue_stream(parts)
    const chunks: StreamChunk[] = []
    const watched = await engine.generate({
      model: 'claude-opus',
      prompt: 'hi',
      on_chunk: (c) => {
        chunks.push(c)
      },
    })

    // Both runs stream, and they fold to what the whole-body reply
    // `{ text: 'hello world', usage: 12 in, 3 out }` gave.
    expect(mock_state.stream_text_call_count).toBe(2)
    expect(normalize_result(watched)).toEqual(normalize_result(without))
    expect(without.content).toBe('hello world')
    expect(without.usage).toStrictEqual({ input_tokens: 12, output_tokens: 3 })
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.at(-1)?.kind).toBe('finish')
  })

  it('a tool loop with reasoning yields equal results with and without on_chunk', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    const lookup: Tool = {
      name: 'lookup',
      description: 'look a key up',
      input_schema: z.object({ key: z.string() }),
      execute: () => 'value',
    }
    const turns: FakeStreamPart[][] = [
      [
        { type: 'reasoning-delta', text: 'need the key' },
        { type: 'text-delta', text: 'Looking.' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', input: { key: 'a' } },
        { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 6, reasoningTokens: 2 } },
      ],
      [
        { type: 'text-delta', text: 'found it' },
        { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 2 } },
      ],
    ]
    const run = async (on_chunk?: (c: StreamChunk) => void): Promise<GenerateResult> => {
      for (const turn of turns) enqueue_stream(turn)
      return engine.generate({
        model: 'claude-opus',
        prompt: 'look a up',
        tools: [lookup],
        ...(on_chunk !== undefined ? { on_chunk } : {}),
      })
    }

    const without = await run()
    const watched = await run(() => {})

    expect(normalize_result(watched)).toEqual(normalize_result(without))
    expect(without.content).toBe('found it')
    expect(without.tool_calls.map(strip_tc)).toStrictEqual([
      { id: 'call_1', name: 'lookup', input: { key: 'a' }, output: 'value', error: undefined },
    ])
    expect(without.steps.map((step) => [step.text, step.finish_reason])).toStrictEqual([
      ['Looking.', 'tool_calls'],
      ['found it', 'stop'],
    ])
  })
})
