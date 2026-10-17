/**
 * native_shared.ts's assistant-part helpers: the filter that keeps a
 * reasoning part only for the provider whose key it carries, and the
 * three-way split the chat-completions and Ollama mappers serialize from.
 * The wire plumbing in the same module is covered through each adapter's own
 * tests.
 */

import { describe, expect, it } from 'vitest'
import type { AssistantContentPart } from '../../types.js'
import { is_own_reasoning, split_assistant_parts } from '../native_shared.js'

type ReasoningPart = Extract<AssistantContentPart, { type: 'reasoning' }>

const own: ReasoningPart = {
  type: 'reasoning',
  text: 'mine',
  provider_options: { openrouter: { detail: { type: 'reasoning.text', text: 'mine' } } },
}
const foreign: ReasoningPart = {
  type: 'reasoning',
  text: 'theirs',
  provider_options: { anthropic: { signature: 'sig' } },
}
const bare: ReasoningPart = { type: 'reasoning', text: 'no data' }

describe('is_own_reasoning', () => {
  it('keeps a part carrying data under the provider key', () => {
    expect(is_own_reasoning(own, 'openrouter')).toBe(true)
  })

  it('drops a part keyed for another provider', () => {
    expect(is_own_reasoning(foreign, 'openrouter')).toBe(false)
  })

  it('drops a part with no data', () => {
    expect(is_own_reasoning(bare, 'openrouter')).toBe(false)
  })
})

describe('split_assistant_parts', () => {
  it('returns the text runs, the tool calls, and the provider\'s own reasoning, each in order', () => {
    const later: ReasoningPart = {
      type: 'reasoning',
      text: '',
      provider_options: { openrouter: { detail: { type: 'reasoning.encrypted', data: 'e' } } },
    }
    const parts: AssistantContentPart[] = [
      own,
      { type: 'text', text: 'a' },
      foreign,
      { type: 'tool_call', id: 'c1', name: 'search', input: { q: 'x' } },
      bare,
      { type: 'text', text: 'b' },
      later,
    ]
    expect(split_assistant_parts(parts, 'openrouter')).toStrictEqual({
      texts: ['a', 'b'],
      tool_parts: [{ type: 'tool_call', id: 'c1', name: 'search', input: { q: 'x' } }],
      reasoning: [own, later],
    })
  })
})
