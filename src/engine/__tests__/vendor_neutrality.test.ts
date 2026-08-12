/**
 * Vendor neutrality: a tool defined with ArkType works end to end (Q4).
 *
 * Every other test in this repo defines schemas with zod, which is the one
 * vendor fascicle is developed against — so they cannot tell a neutral seam
 * from a zod-shaped one. This file imports ArkType and never zod, covering
 * both directions a user's schema travels: out to a provider as JSON Schema,
 * and back in as a value to validate. If fascicle regains a zod assumption on
 * either path, this file fails while the zod-based suites stay green.
 *
 * ArkType over Valibot because it emits Standard JSON Schema from the one
 * package; Valibot needs a second for emission.
 */

import { describe, expect, it } from 'vitest'
import { type } from 'arktype'
import { create_engine } from '../create_engine.js'
import { to_anthropic_tools } from '../providers/anthropic_native.js'
import { to_chat_tools } from '../providers/openai_compatible_native.js'
import { compile_schema } from '../providers/claude_cli/adapter.js'
import { default_normalize_usage, type ProviderFactory } from '../providers/types.js'
import type { Tool, TurnRequest, TurnResult } from '../types.js'

const weather = {
  name: 'get_weather',
  description: 'Look up current weather for a city',
  input_schema: type({ city: 'string' }),
  execute: (input: unknown) => `sunny in ${(input as { city: string }).city}`,
} satisfies Tool

/**
 * A native provider whose turns are scripted, recording each request so the
 * emitted tool payload can be inspected.
 */
function make_native_factory(
  requests: TurnRequest[],
  turns: ReadonlyArray<() => TurnResult>,
): ProviderFactory {
  return () => ({
    kind: 'native',
    name: 'stub_native',
    invoke_turn: async (req) => {
      requests.push(req)
      const turn = turns[requests.length - 1]
      if (turn === undefined) throw new Error(`no scripted turn for step ${req.step_index}`)
      return turn()
    },
    normalize_usage: default_normalize_usage,
    supports: () => true,
  })
}

function make_engine(requests: TurnRequest[], turns: ReadonlyArray<() => TurnResult>) {
  return create_engine({
    providers: { stub_native: {} },
    custom_providers: { stub_native: make_native_factory(requests, turns) },
  })
}

describe('an ArkType tool round-trips end to end', () => {
  it('validates the model tool-call input and feeds the result back', async () => {
    const requests: TurnRequest[] = []
    const engine = make_engine(requests, [
      () => ({
        text: '',
        tool_calls: [{ id: 'c1', name: 'get_weather', input: { city: 'Lisbon' } }],
        finish_reason: 'tool_calls',
        usage: { input_tokens: 2, output_tokens: 2 },
      }),
      () => ({
        text: 'It is sunny.',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
    ])

    const result = await engine.generate({
      model: 'stub-1',
      prompt: 'weather in Lisbon?',
      tools: [weather],
    })

    expect(result.content).toBe('It is sunny.')
    expect(result.tool_calls[0]).toMatchObject({
      name: 'get_weather',
      input: { city: 'Lisbon' },
      output: 'sunny in Lisbon',
    })
    // The executed result reaching the second turn is what makes this a
    // round trip rather than a one-way emission check.
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      name: 'get_weather',
      content: 'sunny in Lisbon',
    })
  })

  it('rejects a bad tool input with an ArkType issue message, no zod involved', async () => {
    const requests: TurnRequest[] = []
    const engine = make_engine(requests, [
      () => ({
        text: '',
        tool_calls: [{ id: 'c1', name: 'get_weather', input: { city: 42 } }],
        finish_reason: 'tool_calls',
        usage: { input_tokens: 2, output_tokens: 2 },
      }),
      () => ({
        text: 'giving up',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ])

    const result = await engine.generate({
      model: 'stub-1',
      prompt: 'weather?',
      tools: [weather],
    })

    const error_message = result.tool_calls[0]?.error?.message
    expect(error_message).toContain('invalid tool input')
    // The path prefix comes from fascicle's normalization, the prose from
    // ArkType: proof the issue survived a non-zod vendor intact.
    expect(error_message).toContain('city')
    expect(error_message).toContain('must be a string')
  })
})

describe('an ArkType schema reaches each provider as JSON Schema', () => {
  const expected_properties = { city: { type: 'string' } }

  it('emits through the Anthropic mapper', () => {
    const tools = to_anthropic_tools([weather])
    expect(tools[0]?.input_schema).toMatchObject({
      type: 'object',
      properties: expected_properties,
      required: ['city'],
    })
  })

  it('emits through the OpenAI-compatible mapper', () => {
    const tools = to_chat_tools([weather])
    expect(tools[0]?.function.parameters).toMatchObject({
      type: 'object',
      properties: expected_properties,
      required: ['city'],
    })
  })

  it('emits through the claude_cli compiler, still stripping $schema', () => {
    const json = JSON.parse(compile_schema(type({ city: 'string' }))) as Record<string, unknown>
    expect(json).not.toHaveProperty('$schema')
    expect(json).not.toHaveProperty('$id')
    expect(json['properties']).toMatchObject(expected_properties)
  })
})
