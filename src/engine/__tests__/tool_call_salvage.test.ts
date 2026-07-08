/**
 * Colocated unit tests for tool_call_salvage.ts.
 *
 * Parser-level coverage: each of the three text formats, the shape guard
 * against JSON-in-prose false positives, the mask rule that keeps the bare
 * pass out of <tool_call> blocks and fences, and the qwen_xml string-param
 * coercion order. Loop integration lives in tool_loop.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Tool } from '../types.js'
import { salvage_tool_calls, scan_balanced_json } from '../tool_call_salvage.js'

function make_tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: overrides.name ?? 'echo',
    description: overrides.description ?? 'echo tool',
    input_schema: overrides.input_schema ?? z.object({ value: z.string() }),
    execute: overrides.execute ?? ((): string => 'ok'),
  }
}

function registry(...tools: Tool[]): ReadonlyMap<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]))
}

const echo_registry = registry(make_tool())

describe('scan_balanced_json', () => {
  it('finds the extent of a nested object with braces and quotes in strings', () => {
    const text = 'x {"a":{"b":"c } d","e":"f \\" {"},"g":[1,{"h":2}]} y'
    const result = scan_balanced_json(text, 2)
    expect(result).toBeDefined()
    expect(result?.value).toEqual({ a: { b: 'c } d', e: 'f " {' }, g: [1, { h: 2 }] })
    expect(text.slice(result?.end)).toBe(' y')
  })

  it('returns undefined when start is not an opening brace', () => {
    expect(scan_balanced_json('abc', 0)).toBeUndefined()
  })

  it('returns undefined for an unbalanced object', () => {
    expect(scan_balanced_json('{"a": {"b": 1}', 0)).toBeUndefined()
  })

  it('returns undefined when the balanced slice is not valid JSON', () => {
    expect(scan_balanced_json("{'a': 1}", 0)).toBeUndefined()
  })
})

describe('salvage_tool_calls: hermes', () => {
  it('salvages a single block and strips it from the text', () => {
    const text = 'I will call the tool.\n<tool_call>{"name":"echo","arguments":{"value":"hi"}}</tool_call>\nDone.'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome).toBeDefined()
    expect(outcome?.calls).toHaveLength(1)
    expect(outcome?.calls[0]).toMatchObject({
      name: 'echo',
      input: { value: 'hi' },
      format: 'hermes',
    })
    expect(outcome?.stripped_text).toBe('I will call the tool.\n\nDone.')
  })

  it('handles nested braces and quotes inside argument strings', () => {
    const text = '<tool_call>{"name":"echo","arguments":{"value":"a } { \\" b"}}</tool_call>'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls[0]?.input).toEqual({ value: 'a } { " b' })
  })

  it('rejects an unknown tool name', () => {
    const text = '<tool_call>{"name":"nope","arguments":{"value":"hi"}}</tool_call>'
    expect(salvage_tool_calls(text, echo_registry)).toBeUndefined()
  })

  it('rejects arguments that fail the schema', () => {
    const text = '<tool_call>{"name":"echo","arguments":{"value":42}}</tool_call>'
    expect(salvage_tool_calls(text, echo_registry)).toBeUndefined()
  })

  it('salvages two blocks in textual order', () => {
    const text =
      '<tool_call>{"name":"echo","arguments":{"value":"first"}}</tool_call> then ' +
      '<tool_call>{"name":"echo","arguments":{"value":"second"}}</tool_call>'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls.map((c) => c.input)).toEqual([{ value: 'first' }, { value: 'second' }])
    expect(outcome?.stripped_text).toBe('then')
  })

  it('ignores an unterminated block without throwing', () => {
    const text = '<tool_call>{"name":"echo","arguments":{"value":"hi"}}'
    expect(salvage_tool_calls(text, echo_registry)).toBeUndefined()
  })

  it('yields exactly one call per block (no double-match by the bare pass)', () => {
    const text = '<tool_call>{"name":"echo","arguments":{"value":"hi"}}</tool_call>'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls).toHaveLength(1)
    expect(outcome?.stripped_text).toBe('')
  })
})

describe('salvage_tool_calls: bare and fenced json', () => {
  it('salvages a bare object mid-prose and keeps the surrounding prose', () => {
    const text = 'Let me run it: {"name":"echo","arguments":{"value":"hi"}} and wait.'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls[0]).toMatchObject({ name: 'echo', format: 'json' })
    expect(outcome?.stripped_text).toBe('Let me run it:  and wait.')
  })

  it('salvages a ```json fence and strips the whole fence', () => {
    const text = 'Calling:\n```json\n{"name":"echo","arguments":{"value":"hi"}}\n```\nend'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls[0]).toMatchObject({ name: 'echo', format: 'json' })
    expect(outcome?.stripped_text).toBe('Calling:\n\nend')
  })

  it('salvages a plain fence with no info string', () => {
    const text = '```\n{"name":"echo","arguments":{"value":"hi"}}\n```'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls).toHaveLength(1)
    expect(outcome?.stripped_text).toBe('')
  })

  it('does not parse a fence with a non-json info string but masks it', () => {
    const text = '```python\n{"name":"echo","arguments":{"value":"hi"}}\n```'
    expect(salvage_tool_calls(text, echo_registry)).toBeUndefined()
  })

  it('rejects an object with an extra third key', () => {
    const text = '{"name":"echo","arguments":{"value":"hi"},"id":"x"}'
    expect(salvage_tool_calls(text, echo_registry)).toBeUndefined()
  })

  it('rejects non-string name, array arguments, and null arguments', () => {
    expect(
      salvage_tool_calls('{"name":42,"arguments":{"value":"hi"}}', echo_registry),
    ).toBeUndefined()
    expect(salvage_tool_calls('{"name":"echo","arguments":[1]}', echo_registry)).toBeUndefined()
    expect(salvage_tool_calls('{"name":"echo","arguments":null}', echo_registry)).toBeUndefined()
  })

  it('does not throw on broken JSON', () => {
    expect(salvage_tool_calls('{"name": "echo", ', echo_registry)).toBeUndefined()
  })

  it('keeps invalid candidates in the text while salvaging valid ones', () => {
    const text =
      '{"name":"nope","arguments":{"value":"a"}} and {"name":"echo","arguments":{"value":"b"}}'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls).toHaveLength(1)
    expect(outcome?.calls[0]?.input).toEqual({ value: 'b' })
    expect(outcome?.stripped_text).toBe('{"name":"nope","arguments":{"value":"a"}} and')
  })

  it('does not re-match a rejected hermes payload as bare json (mask rule)', () => {
    // Shape-valid payload, unknown tool: the block is rejected, and the bare
    // pass must not resurrect the JSON inside it.
    const text = '<tool_call>{"name":"nope","arguments":{"value":"a"}}</tool_call>'
    expect(salvage_tool_calls(text, echo_registry)).toBeUndefined()
  })

  it('does not descend into a non-call object to find nested candidates', () => {
    const text = '{"outer":true,"inner":{"name":"echo","arguments":{"value":"hi"}}}'
    expect(salvage_tool_calls(text, echo_registry)).toBeUndefined()
  })
})

describe('salvage_tool_calls: qwen_xml', () => {
  it('salvages string params', () => {
    const text =
      '<tool_call><function=echo><parameter=value>\nhi\n</parameter></function></tool_call>'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls[0]).toMatchObject({
      name: 'echo',
      input: { value: 'hi' },
      format: 'qwen_xml',
    })
    expect(outcome?.stripped_text).toBe('')
  })

  it('coerces a numeric string param when the schema wants a number', () => {
    const tools = registry(make_tool({ name: 'add', input_schema: z.object({ n: z.number() }) }))
    const text = '<tool_call><function=add><parameter=n>3</parameter></function></tool_call>'
    const outcome = salvage_tool_calls(text, tools)
    expect(outcome?.calls[0]?.input).toEqual({ n: 3 })
  })

  it('keeps a numeric-looking string when the schema wants a string (raw-first)', () => {
    const text = '<tool_call><function=echo><parameter=value>3</parameter></function></tool_call>'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls[0]?.input).toEqual({ value: '3' })
  })

  it('coerces params independently: one parses, one stays a raw string', () => {
    const tools = registry(
      make_tool({
        name: 'mix',
        input_schema: z.object({ n: z.number(), label: z.string() }),
      }),
    )
    const text =
      '<tool_call><function=mix><parameter=n>3</parameter><parameter=label>plain text</parameter></function></tool_call>'
    const outcome = salvage_tool_calls(text, tools)
    expect(outcome?.calls[0]?.input).toEqual({ n: 3, label: 'plain text' })
  })

  it('coerces an object-valued param against an object schema', () => {
    const tools = registry(
      make_tool({
        name: 'cfg',
        input_schema: z.object({ options: z.object({ deep: z.boolean() }) }),
      }),
    )
    const text =
      '<tool_call><function=cfg><parameter=options>{"deep":true}</parameter></function></tool_call>'
    const outcome = salvage_tool_calls(text, tools)
    expect(outcome?.calls[0]?.input).toEqual({ options: { deep: true } })
  })

  it('rejects when coercion still fails the schema', () => {
    const tools = registry(make_tool({ name: 'add', input_schema: z.object({ n: z.number() }) }))
    const text = '<tool_call><function=add><parameter=n>lots</parameter></function></tool_call>'
    expect(salvage_tool_calls(text, tools)).toBeUndefined()
  })

  it('strips exactly one leading and trailing newline and keeps interior ones', () => {
    const text =
      '<tool_call><function=echo><parameter=value>\nline1\nline2\n</parameter></function></tool_call>'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls[0]?.input).toEqual({ value: 'line1\nline2' })
  })

  it('salvages two functions in one block', () => {
    const text =
      '<tool_call><function=echo><parameter=value>a</parameter></function>' +
      '<function=echo><parameter=value>b</parameter></function></tool_call>'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls.map((c) => c.input)).toEqual([{ value: 'a' }, { value: 'b' }])
    expect(outcome?.stripped_text).toBe('')
  })

  it('rejects a function body with garbage between parameters', () => {
    const text =
      '<tool_call><function=echo>note<parameter=value>hi</parameter></function></tool_call>'
    expect(salvage_tool_calls(text, echo_registry)).toBeUndefined()
  })

  it('ignores a function missing its closing tag without throwing', () => {
    const text = '<tool_call><function=echo><parameter=value>hi</parameter></tool_call>'
    expect(salvage_tool_calls(text, echo_registry)).toBeUndefined()
  })
})

describe('salvage_tool_calls: cross-format and degenerate input', () => {
  it('salvages a hermes block and a bare object together in textual order', () => {
    const text =
      'first {"name":"echo","arguments":{"value":"bare"}} then ' +
      '<tool_call>{"name":"echo","arguments":{"value":"hermes"}}</tool_call>'
    const outcome = salvage_tool_calls(text, echo_registry)
    expect(outcome?.calls.map((c) => [c.format, c.input])).toEqual([
      ['json', { value: 'bare' }],
      ['hermes', { value: 'hermes' }],
    ])
    expect(outcome?.stripped_text).toBe('first  then')
  })

  it('returns undefined for empty, whitespace, and candidate-free text', () => {
    expect(salvage_tool_calls('', echo_registry)).toBeUndefined()
    expect(salvage_tool_calls('   \n  ', echo_registry)).toBeUndefined()
    expect(salvage_tool_calls('The answer is 42.', echo_registry)).toBeUndefined()
  })
})
