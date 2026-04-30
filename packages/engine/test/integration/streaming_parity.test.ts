/**
 * Streaming parity (spec §5.6, §10 / criterion 8).
 *
 * For the same mocked provider response, `generate` must return a deeply-equal
 * GenerateResult whether `on_chunk` is supplied (streaming) or omitted
 * (non-streaming). This is the invariant that lets composers stay unaware of
 * streaming — they read the result, streaming is a pure observation seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  build_mock_ai_module,
  build_mock_registry_module,
  enqueue_generate_text,
  enqueue_stream,
  reset_mock_state,
} from '../fixtures/mock_ai.js'

vi.mock('ai', async () => build_mock_ai_module())
vi.mock('../../src/providers/registry.js', async () => build_mock_registry_module())

import { create_engine } from '../../src/create_engine.js'
import type { GenerateResult, StreamChunk } from '../../src/types.js'

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
  
    enqueue_generate_text({
      text: 'hello world',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 3 },
    })
    const non_streamed = await engine.generate({ model: 'claude-opus', prompt: 'hi' })
  
    enqueue_stream([
      { type: 'text-delta', text: 'hello ' },
      { type: 'text-delta', text: 'world' },
      {
        type: 'finish-step',
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: 3 },
      },
    ])
    const chunks: StreamChunk[] = []
    const streamed = await engine.generate({
      model: 'claude-opus',
      prompt: 'hi',
      on_chunk: (c) => {
        chunks.push(c)
      },
    })
  
    expect(normalize_result(streamed)).toEqual(normalize_result(non_streamed))
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.at(-1)?.kind).toBe('finish')
  })
})
