import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { define_tool } from '#engine'
import type { Message, Tool, TurnRequest } from '#engine'
import type { ToolSchema } from '#schema'
import { assert_prefix_stable } from '../assert_prefix_stable.js'
import { make_loop_engine } from '../make_loop_engine.js'

const read_file = define_tool({
  name: 'read_file',
  description: 'Read a file.',
  input_schema: z.object({ path: z.string() }),
  execute: ({ path }) => `contents of ${path}`,
})

const search = define_tool({
  name: 'search',
  description: 'Search the workspace.',
  input_schema: z.object({ pattern: z.string() }),
  execute: ({ pattern }) => [`a.ts: ${pattern}`],
})

/**
 * A Standard Schema with no JSON Schema behind it, so `to_json_schema` can't
 * convert it. The type forbids one, and the cast stands in for a runtime
 * where the type doesn't reach.
 */
function bare_schema(): ToolSchema {
  return { '~standard': { version: 1, vendor: 'bare', validate: (value: unknown) => ({ value }) } } as unknown as ToolSchema
}

/** `read_file` with one field swapped out. */
function read_file_with(fields: Partial<Tool>): Tool {
  return { ...read_file, ...fields }
}

/** A request at `step_index`, empty but for the fields given. */
function request(step_index: number, fields: Partial<Pick<TurnRequest, 'system' | 'tools' | 'messages'>> = {}): TurnRequest {
  return {
    step_index,
    messages: [],
    tools: [],
    abort: new AbortController().signal,
    stream: false,
    model_id: 'loop',
    effort: 'none',
    ...fields,
  }
}

const ask: Message = { role: 'user', content: 'where are the TODOs?' }
const called: Message = {
  role: 'assistant',
  content: [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts', line: 1 } }],
}
const answered: Message = { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'contents of a.ts' }

const HINT = '(the check reads calls that ran one at a time, so a parallel flow takes one double per branch)'

describe('assert_prefix_stable', () => {
  it('passes a tool loop whose turns only append', async () => {
    const { engine, requests } = make_loop_engine([
      [{ name: 'search', input: { pattern: 'TODO' } }],
      [
        { name: 'read_file', input: { path: 'a.ts' } },
        { name: 'read_file', input: { path: 'b.ts' } },
      ],
      'a.ts has one TODO',
    ])
    await engine.generate({ prompt: 'where are the TODOs?', system: 'be brief', tools: [read_file, search] })
    expect(requests).toHaveLength(3)
    expect(() => {
      assert_prefix_stable(requests)
    }).not.toThrow()
  })

  it('passes two calls on one engine, each checked on its own', async () => {
    const { engine, requests } = make_loop_engine([[{ name: 'search', input: { pattern: 'x' } }], 'found', 'hello'])
    await engine.generate({ prompt: 'find x', system: 'search', tools: [search] })
    await engine.generate({ prompt: 'hi', system: 'chat' })
    expect(requests.map((req) => req.step_index)).toEqual([0, 1, 0])
    expect(() => {
      assert_prefix_stable(requests)
    }).not.toThrow()
  })

  it('starts a new call where a step repeats, as a retried turn does', () => {
    expect(() => {
      assert_prefix_stable([request(0, { messages: [ask] }), request(0, { messages: [answered] })])
    }).not.toThrow()
  })

  it('passes no requests at all', () => {
    expect(() => {
      assert_prefix_stable([])
    }).not.toThrow()
  })

  it('fails a changed system prompt, naming the call, the step, and the hint', () => {
    expect(() => {
      assert_prefix_stable([request(0, { system: 'be brief' }), request(1, { system: 'be thorough' })])
    }).toThrow(`assert_prefix_stable: call 1, step 1: the system prompt differs from step 0 ${HINT}`)
  })

  it('names the later call when the difference sits there', () => {
    expect(() => {
      assert_prefix_stable([
        request(0, { system: 'a' }),
        request(1, { system: 'a' }),
        request(0, { system: 'b' }),
        request(1, { system: 'c' }),
      ])
    }).toThrow('assert_prefix_stable: call 2, step 1: the system prompt differs from step 0 (')
  })

  it('fails a reordered tool list, listing both orders', () => {
    expect(() => {
      assert_prefix_stable([request(0, { tools: [read_file, search] }), request(1, { tools: [search, read_file] })])
    }).toThrow('call 1, step 1: the tools are [search, read_file] where step 0 sent [read_file, search]')
  })

  it('fails a tool list that grew or shrank', () => {
    expect(() => {
      assert_prefix_stable([request(3, { tools: [read_file] }), request(4, { tools: [read_file, search] })])
    }).toThrow('call 1, step 4: the tools are [read_file, search] where step 3 sent [read_file]')
    expect(() => {
      assert_prefix_stable([request(0, { tools: [read_file, search] }), request(1, { tools: [read_file] })])
    }).toThrow('call 1, step 1: the tools are [read_file] where step 0 sent [read_file, search]')
  })

  it('fails a changed tool description', () => {
    expect(() => {
      assert_prefix_stable([
        request(0, { tools: [read_file] }),
        request(1, { tools: [read_file_with({ description: 'Read any file.' })] }),
      ])
    }).toThrow('call 1, step 1: the description of tool read_file differs from step 0 (')
  })

  it('fails a changed tool schema', () => {
    expect(() => {
      assert_prefix_stable([
        request(0, { tools: [read_file] }),
        request(1, { tools: [read_file_with({ input_schema: z.object({ path: z.string(), line: z.number() }) })] }),
      ])
    }).toThrow('call 1, step 1: the input schema of tool read_file differs from step 0 (')
  })

  it('passes a schema rebuilt as a new object with the same JSON Schema', () => {
    expect(() => {
      assert_prefix_stable([
        request(0, { tools: [read_file] }),
        request(1, { tools: [read_file_with({ input_schema: z.object({ path: z.string() }) })] }),
      ])
    }).not.toThrow()
  })

  it('passes a schema it cannot convert while the tool keeps the same object', () => {
    const tool = read_file_with({ input_schema: bare_schema() })
    expect(() => {
      assert_prefix_stable([request(0, { tools: [tool] }), request(1, { tools: [tool] })])
    }).not.toThrow()
  })

  it('fails a schema it cannot convert once the tool holds a new object, naming the tool', () => {
    expect(() => {
      assert_prefix_stable([
        request(0, { tools: [read_file_with({ input_schema: bare_schema() })] }),
        request(1, { tools: [read_file_with({ input_schema: bare_schema() })] }),
      ])
    }).toThrow(
      "call 1, step 1: the input schema of tool read_file is a new object since step 0, and it has no JSON Schema to compare (",
    )
  })

  it('fails a changed message', () => {
    expect(() => {
      assert_prefix_stable([
        request(0, { messages: [ask] }),
        request(1, { messages: [{ role: 'user', content: 'where are the FIXMEs?' }, called] }),
      ])
    }).toThrow('call 1, step 1: message 0 differs from step 0 (')
  })

  it('fails a message whose keys were reordered, since the wire sends JSON text', () => {
    const reordered: Message = {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { line: 1, path: 'a.ts' } }],
    }
    expect(() => {
      assert_prefix_stable([
        request(5, { messages: [ask, called] }),
        request(6, { messages: [ask, reordered, answered] }),
      ])
    }).toThrow('call 1, step 6: message 1 differs from step 5 (')
  })

  it('fails a dropped message, whether others shift into its place or none follow it', () => {
    expect(() => {
      assert_prefix_stable([
        request(0, { messages: [ask, called, answered] }),
        request(1, { messages: [ask, answered, called] }),
      ])
    }).toThrow('call 1, step 1: message 1 differs from step 0 (')
    expect(() => {
      assert_prefix_stable([request(0, { messages: [ask, called, answered] }), request(1, { messages: [ask, called] })])
    }).toThrow('call 1, step 1: message 2 from step 0 is missing (')
  })

  it('fails a prepare_step sliding window once it drops the oldest message', async () => {
    const { engine, requests } = make_loop_engine([
      [{ name: 'search', input: { pattern: 'TODO' } }],
      [{ name: 'read_file', input: { path: 'a.ts' } }],
      'one TODO',
    ])
    await engine.generate({
      prompt: 'where are the TODOs?',
      tools: [read_file, search],
      prepare_step: ({ messages }) => ({ messages: messages.slice(-2) }),
    })
    expect(() => {
      assert_prefix_stable(requests)
    }).toThrow('call 1, step 1: message 0 differs from step 0 (')
  })
})
