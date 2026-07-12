/**
 * Colocated unit tests for tool_loop.ts.
 *
 * These exercise the loop with a mock invoke_once seam so the behavior is
 * testable without the `ai` SDK. Integration behavior (SDK call path, retry,
 * streaming) lives in generate.test.ts.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { TrajectoryLogger } from '#core'
import {
  run_tool_loop,
  type InvokeOnce,
  type InvokeOnceResult,
  type RawToolCall,
  type ToolLoopConfig,
} from '../tool_loop.js'
import type { Message, StreamChunk, Tool, UsageTotals } from '../types.js'
import { tool_error, tool_approval_denied_error, aborted_error } from '../errors.js'
import { create_pricing_missing_dedup } from '../trajectory.js'

const zero_usage: UsageTotals = { input_tokens: 0, output_tokens: 0 }

function recording_trajectory(): {
  trajectory: TrajectoryLogger
  events: Array<Record<string, unknown>>
} {
  const events: Array<Record<string, unknown>> = []
  let id = 0
  const trajectory: TrajectoryLogger = {
    record: (e) => {
      events.push(e)
    },
    start_span: (name, meta) => {
      id += 1
      events.push({ kind: 'span_start', name, ...meta })
      return `s${id}`
    },
    end_span: (span_id, meta) => {
      events.push({ kind: 'span_end', span_id, ...meta })
    },
  }
  return { trajectory, events }
}

function make_invoke_once(results: ReadonlyArray<Partial<InvokeOnceResult>>): InvokeOnce {
  let call = 0
  return async (): Promise<InvokeOnceResult> => {
    const r = results[call]
    call += 1
    if (r === undefined) throw new Error(`invoke_once called ${call} times but only ${results.length} results supplied`)
    return {
      text: r.text ?? '',
      tool_calls: r.tool_calls ?? [],
      finish_reason: r.finish_reason ?? 'stop',
      usage: r.usage ?? zero_usage,
    }
  }
}

function make_tool(overrides: Partial<Tool> = {}): Tool {
  const execute = overrides.execute ?? ((): string => 'ok')
  return {
    name: overrides.name ?? 'echo',
    description: overrides.description ?? 'echo tool',
    input_schema: overrides.input_schema ?? z.object({ value: z.string() }),
    execute,
    ...(overrides.needs_approval !== undefined ? { needs_approval: overrides.needs_approval } : {}),
    ...(overrides.ends_turn !== undefined ? { ends_turn: overrides.ends_turn } : {}),
  }
}

function pricing_dedup_stub(): ReturnType<typeof create_pricing_missing_dedup> {
  return create_pricing_missing_dedup(undefined)
}

type BaseOverrides = Partial<Omit<ToolLoopConfig, 'invoke_once'>> & {
  invoke: ReadonlyArray<Partial<InvokeOnceResult>>
}
function base_config(overrides: BaseOverrides): ToolLoopConfig {
  const { invoke, ...rest } = overrides
  return {
    invoke_once: make_invoke_once(invoke),
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    max_steps: 10,
    step_index_start: 0,
    tool_error_policy: 'feed_back',
    abort: new AbortController().signal,
    on_tool_approval: undefined,
    trajectory: undefined,
    stream: false,
    dispatch_chunk: undefined,
    provider: 'anthropic',
    model_id: 'claude-opus-4-7',
    resolve_pricing: () => undefined,
    pricing_dedup: pricing_dedup_stub(),
    ...rest,
  }
}
const call = (id: string, name: string, input: unknown): RawToolCall => ({ id, name, input })
function named_thrown(): void {} // module-scoped so its String() form is stable and lint-clean
const tool_message = (messages: Message[]): Message | undefined =>
  messages.find((m) => m.role === 'tool')

describe('run_tool_loop', () => {
  it('resolves a plain completion in one step', async () => {
    const invoke = make_invoke_once([
      { text: 'hello', finish_reason: 'stop', usage: { input_tokens: 5, output_tokens: 3 } },
    ])
    const messages: Message[] = [{ role: 'user', content: 'hi' }]
  
    const result = await run_tool_loop({
      invoke_once: invoke,
      messages,
      tools: [],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    })
    expect(result.text).toBe('hello')
    expect(result.steps).toHaveLength(1)
    expect(result.finish_reason).toBe('stop')
    expect(result.tool_calls).toEqual([])
  })

  it('executes a tool call and feeds the result back', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'echo', input: { value: 'hi' } }
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls', usage: { input_tokens: 10, output_tokens: 2 } },
      { text: 'done', finish_reason: 'stop', usage: { input_tokens: 15, output_tokens: 4 } },
    ])
    const messages: Message[] = [{ role: 'user', content: 'use echo' }]
    const tool = make_tool({
      name: 'echo',
      execute: (input: unknown) => `echoed: ${(input as { value: string }).value}`,
    })
  
    const result = await run_tool_loop({
      invoke_once: invoke,
      messages,
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    })
  
    expect(result.steps).toHaveLength(2)
    expect(result.tool_calls).toHaveLength(1)
    expect(result.tool_calls[0]?.output).toBe('echoed: hi')
    expect(result.text).toBe('done')
  })

  it('records a tool_result event carrying the output on success', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'echo', input: { value: 'hi' } }
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
      { text: 'done', finish_reason: 'stop' },
    ])
    const tool = make_tool({
      name: 'echo',
      execute: (input: unknown) => `echoed: ${(input as { value: string }).value}`,
    })
    const { trajectory, events } = recording_trajectory()

    await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'use echo' }],
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    })

    const result_event = events.find((e) => e['kind'] === 'tool_result')
    expect(result_event).toBeDefined()
    expect(result_event?.['tool_call_id']).toBe('c1')
    expect(result_event?.['output']).toBe('echoed: hi')
    expect(result_event?.['error']).toBeUndefined()
  })

  it('records a tool_result event carrying the error on a failed tool (feed_back)', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'echo', input: { value: 'hi' } }
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
      { text: 'recovered', finish_reason: 'stop' },
    ])
    const tool = make_tool({
      name: 'echo',
      execute: () => {
        throw new Error('kaboom')
      },
    })
    const { trajectory, events } = recording_trajectory()

    await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'use echo' }],
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    })

    const result_event = events.find((e) => e['kind'] === 'tool_result')
    expect(result_event).toBeDefined()
    expect(result_event?.['error']).toEqual({ message: 'kaboom' })
  })

  it('feeds invalid tool input back as an error result without calling execute', async () => {
    const exec_spy = vi.fn()
    const bad: RawToolCall = { id: 'c1', name: 'echo', input: { missing: true } }
    const invoke = make_invoke_once([
      { tool_calls: [bad], finish_reason: 'tool_calls' },
      { text: 'done', finish_reason: 'stop' },
    ])
    const tool = make_tool({ name: 'echo', execute: exec_spy })
  
    const result = await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    })
  
    expect(exec_spy).not.toHaveBeenCalled()
    expect(result.tool_calls[0]?.error?.message).toMatch(/invalid tool input/)
  })

  it('feeds tool execute error back under feed_back policy', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'boom', input: { value: 'x' } }
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
      { text: 'done', finish_reason: 'stop' },
    ])
    const tool = make_tool({
      name: 'boom',
      execute: () => {
        throw new Error('kaboom')
      },
    })
    const result = await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    })
    expect(result.tool_calls[0]?.error?.message).toBe('kaboom')
    expect(result.text).toBe('done')
  })

  it('throws tool_error under throw policy when execute throws', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'boom', input: { value: 'x' } }
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
    ])
    const tool = make_tool({
      name: 'boom',
      execute: () => {
        throw new Error('kaboom')
      },
    })
    await expect(
      run_tool_loop({
        invoke_once: invoke,
        messages: [{ role: 'user', content: 'x' }],
        tools: [tool],
        max_steps: 10,
        step_index_start: 0,
        tool_error_policy: 'throw',
        abort: new AbortController().signal,
        on_tool_approval: undefined,
        trajectory: undefined,
        stream: false,
        dispatch_chunk: undefined,
        provider: 'anthropic',
        model_id: 'claude-opus-4-7',
        resolve_pricing: () => undefined,
        pricing_dedup: pricing_dedup_stub(),
      }),
    ).rejects.toBeInstanceOf(tool_error)
  })

  it('caps at max_steps and marks attempted-but-unexecuted tool calls', async () => {
    const invoke = make_invoke_once([
      {
        tool_calls: [{ id: 'c1', name: 'echo', input: { value: 'a' } }],
        finish_reason: 'tool_calls',
      },
      {
        tool_calls: [{ id: 'c2', name: 'echo', input: { value: 'b' } }],
        finish_reason: 'tool_calls',
      },
      {
        tool_calls: [{ id: 'c3', name: 'echo', input: { value: 'c' } }],
        finish_reason: 'tool_calls',
      },
    ])
    const tool = make_tool({
      name: 'echo',
      execute: (input: unknown) => (input as { value: string }).value,
    })
  
    const result = await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      max_steps: 3,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    })
  
    expect(result.finish_reason).toBe('max_steps')
    expect(result.max_steps_reached).toBe(true)
    const last_call = result.tool_calls.at(-1)
    expect(last_call?.error?.message).toBe('max_steps_exceeded_before_execution')
  })

  it('fails closed when needs_approval is truthy without on_tool_approval', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'danger', input: { value: 'x' } }
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
    ])
    const tool = make_tool({
      name: 'danger',
      needs_approval: true,
    })
  
    await expect(
      run_tool_loop({
        invoke_once: invoke,
        messages: [{ role: 'user', content: 'x' }],
        tools: [tool],
        max_steps: 10,
        step_index_start: 0,
        tool_error_policy: 'feed_back',
        abort: new AbortController().signal,
        on_tool_approval: undefined,
        trajectory: undefined,
        stream: false,
        dispatch_chunk: undefined,
        provider: 'anthropic',
        model_id: 'claude-opus-4-7',
        resolve_pricing: () => undefined,
        pricing_dedup: pricing_dedup_stub(),
      }),
    ).rejects.toBeInstanceOf(tool_approval_denied_error)
  })

  it('rejects with aborted_error when abort fires during approval wait', async () => {
    const controller = new AbortController()
    const tc: RawToolCall = { id: 'c1', name: 'danger', input: { value: 'x' } }
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
    ])
    const tool = make_tool({ name: 'danger', needs_approval: true })
  
    const promise = run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: controller.signal,
      on_tool_approval: () => new Promise(() => {}),
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    })
    setTimeout(() => controller.abort(new Error('user abort')), 20)
    await expect(promise).rejects.toBeInstanceOf(aborted_error)
  })

  it('feeds denial back when approval is rejected under feed_back', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'danger', input: { value: 'x' } }
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
      { text: 'ok', finish_reason: 'stop' },
    ])
    const tool = make_tool({ name: 'danger', needs_approval: true })
  
    const result = await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: () => false,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    })
    expect(result.tool_calls[0]?.error?.message).toBe('tool_approval_denied')
    expect(result.text).toBe('ok')
  })

  it('feeds unknown tool name back under feed_back; throws under throw', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'missing', input: {} }
    {
      const invoke = make_invoke_once([
        { tool_calls: [tc], finish_reason: 'tool_calls' },
        { text: 'ok', finish_reason: 'stop' },
      ])
      const result = await run_tool_loop({
        invoke_once: invoke,
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        max_steps: 10,
        step_index_start: 0,
        tool_error_policy: 'feed_back',
        abort: new AbortController().signal,
        on_tool_approval: undefined,
        trajectory: undefined,
        stream: false,
        dispatch_chunk: undefined,
        provider: 'anthropic',
        model_id: 'claude-opus-4-7',
        resolve_pricing: () => undefined,
        pricing_dedup: pricing_dedup_stub(),
      })
      expect(result.tool_calls[0]?.error?.message).toMatch(/unknown tool/)
    }
    {
      const invoke = make_invoke_once([
        { tool_calls: [tc], finish_reason: 'tool_calls' },
      ])
      await expect(
        run_tool_loop({
          invoke_once: invoke,
          messages: [{ role: 'user', content: 'x' }],
          tools: [],
          max_steps: 10,
          step_index_start: 0,
          tool_error_policy: 'throw',
          abort: new AbortController().signal,
          on_tool_approval: undefined,
          trajectory: undefined,
          stream: false,
          dispatch_chunk: undefined,
          provider: 'anthropic',
          model_id: 'claude-opus-4-7',
          resolve_pricing: () => undefined,
          pricing_dedup: pricing_dedup_stub(),
        }),
      ).rejects.toBeInstanceOf(tool_error)
    }
  })

  it('executes multiple tool calls in a single turn sequentially and records order', async () => {
    const order: string[] = []
    const tool_a = make_tool({
      name: 'a',
      execute: async (input: unknown) => {
        order.push(`a-${(input as { value: string }).value}`)
        return 'A'
      },
    })
    const tool_b = make_tool({
      name: 'b',
      execute: async (input: unknown) => {
        order.push(`b-${(input as { value: string }).value}`)
        return 'B'
      },
    })
    const invoke = make_invoke_once([
      {
        tool_calls: [
          { id: 'c1', name: 'a', input: { value: '1' } },
          { id: 'c2', name: 'b', input: { value: '2' } },
        ],
        finish_reason: 'tool_calls',
      },
      { text: 'ok', finish_reason: 'stop' },
    ])
    const result = await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool_a, tool_b],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    })
    expect(order).toEqual(['a-1', 'b-2'])
    expect(result.tool_calls.map((c) => c.id)).toEqual(['c1', 'c2'])
  })
})

describe('run_tool_loop detail', () => {
  it('records output, feed message, dispatch chunk, and trajectory events on success', async () => {
    const chunks: StreamChunk[] = []
    const { trajectory, events } = recording_trajectory()
    const messages: Message[] = [{ role: 'user', content: 'go' }]
    const tool = make_tool({ name: 'echo', execute: () => ({ result: 42 }) })
    const out = await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [tool],
        messages,
        trajectory,
        dispatch_chunk: async (c) => {
          chunks.push(c)
        },
      }),
    )
    expect(out.tool_calls[0]).toMatchObject({
      id: 'c1',
      name: 'echo',
      input: { value: 'x' },
      output: { result: 42 },
    })
    expect(out.tool_calls[0]?.error).toBeUndefined()
    // The tool-result message serializes the object output as JSON.
    expect(tool_message(messages)).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
      name: 'echo',
      content: JSON.stringify({ result: 42 }),
    })
    // The dispatched chunk carries the structured output and step index.
    expect(chunks.find((c) => c.kind === 'tool_result')).toMatchObject({
      kind: 'tool_result',
      id: 'c1',
      step_index: 0,
      output: { result: 42 },
    })
    const call_event = events.find((e) => e['kind'] === 'tool_call')
    expect(call_event).toMatchObject({ tool_call_id: 'c1', name: 'echo', input: { value: 'x' } })
  })

  it('builds an assistant message with text + tool_call parts, and plain text when no calls', async () => {
    const with_calls: Message[] = [{ role: 'user', content: 'go' }]
    await run_tool_loop(
      base_config({
        invoke: [{ text: 'thinking', tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [make_tool({ name: 'echo' })],
        messages: with_calls,
      }),
    )
    const assistant = with_calls.find((m) => m.role === 'assistant')
    expect(Array.isArray(assistant?.content)).toBe(true)
    expect(assistant?.content).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool_call', id: 'c1', name: 'echo', input: { value: 'x' } },
    ])

    const plain: Message[] = [{ role: 'user', content: 'go' }]
    await run_tool_loop(base_config({ invoke: [{ text: 'just text' }], messages: plain }))
    expect(plain.find((m) => m.role === 'assistant')).toEqual({ role: 'assistant', content: 'just text' })
  })

  it('feeds back an unknown tool with the exact message and skips when none match', async () => {
    const messages: Message[] = [{ role: 'user', content: 'go' }]
    const out = await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'missing', {})], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [make_tool({ name: 'echo' })],
        messages,
      }),
    )
    expect(out.tool_calls[0]?.error?.message).toBe("unknown tool 'missing'")
    expect(tool_message(messages)?.content).toBe(JSON.stringify({ error: "unknown tool 'missing'" }))
  })

  it('feeds back invalid input without calling execute', async () => {
    let executed = false
    const tool = make_tool({
      name: 'echo',
      input_schema: z.object({ value: z.string() }),
      execute: () => {
        executed = true
        return 'ok'
      },
    })
    const out = await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'echo', { value: 123 })], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [tool],
      }),
    )
    expect(executed).toBe(false)
    expect(out.tool_calls[0]?.error?.message).toMatch(/^invalid tool input: /)
  })

  it('serializes a thrown Error, string, and non-serializable value as the error message', async () => {
    const make = (execute: Tool['execute']): BaseOverrides => ({
      invoke: [{ tool_calls: [call('c1', 'boom', {})], finish_reason: 'tool_calls' }, { text: 'done' }],
      tools: [make_tool({ name: 'boom', input_schema: z.object({}), execute })],
    })
    const err_msg = async (execute: Tool['execute']): Promise<string | undefined> =>
      (await run_tool_loop(base_config(make(execute)))).tool_calls[0]?.error?.message

    expect(await err_msg(() => {
      throw new Error('kaboom')
    })).toBe('kaboom')
    expect(await err_msg(() => {
      throw 'string failure'
    })).toBe('string failure')
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(await err_msg(() => {
      throw circular
    })).toBe('[object Object]') // JSON.stringify throws -> String() fallback
  })

  it('wraps a thrown tool error under throw policy with tool metadata', async () => {
    let caught: unknown
    try {
      await run_tool_loop(
        base_config({
          invoke: [{ tool_calls: [call('c1', 'boom', {})], finish_reason: 'tool_calls' }],
          tools: [
            make_tool({
              name: 'boom',
              input_schema: z.object({}),
              execute: () => {
                throw new Error('inner')
              },
            }),
          ],
          tool_error_policy: 'throw',
        }),
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(tool_error)
    expect((caught as tool_error).message).toBe("tool 'boom' failed: inner")
    expect((caught as tool_error).tool_name).toBe('boom')
    expect((caught as tool_error).tool_call_id).toBe('c1')
  })

  it('consults a needs_approval predicate with the parsed input and runs once granted', async () => {
    let seen_input: unknown
    const tool = make_tool({
      name: 'echo',
      needs_approval: (input: unknown) => {
        seen_input = input
        return true
      },
      execute: () => 'ran',
    })
    const out = await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [tool],
        on_tool_approval: () => true,
      }),
    )
    expect(seen_input).toEqual({ value: 'x' })
    expect(out.tool_calls[0]?.output).toBe('ran')
  })

  it('feeds back denial with the canonical message under feed_back', async () => {
    const out = await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [make_tool({ name: 'echo', needs_approval: true })],
        on_tool_approval: () => false,
      }),
    )
    expect(out.tool_calls[0]?.error?.message).toBe('tool_approval_denied')
  })

  it('marks unexecuted tool calls when the next step would exceed max_steps', async () => {
    const out = await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }],
        tools: [make_tool({ name: 'echo' })],
        max_steps: 1,
      }),
    )
    expect(out.max_steps_reached).toBe(true)
    expect(out.finish_reason).toBe('max_steps')
    expect(out.tool_calls[0]?.error?.message).toBe('max_steps_exceeded_before_execution')
  })

  it('throws aborted_error carrying the step index when aborted before a turn', async () => {
    const controller = new AbortController()
    controller.abort('stop')
    let err: unknown
    try {
      await run_tool_loop(base_config({ invoke: [{ text: 'x' }], abort: controller.signal, step_index_start: 2 }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).step_index).toBe(2)
  })

  it('throws aborted_error carrying the in-flight tool call when aborted mid-turn', async () => {
    const controller = new AbortController()
    const invoke: InvokeOnce = async () => {
      controller.abort('stop') // aborts after the loop-top check, before the per-call check
      return { text: '', tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls', usage: zero_usage }
    }
    let err: unknown
    try {
      await run_tool_loop({
        ...base_config({ invoke: [{}] }),
        invoke_once: invoke,
        tools: [make_tool({ name: 'echo' })],
        abort: controller.signal,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).tool_call_in_flight).toEqual({ id: 'c1', name: 'echo' })
  })

  it('serializes a thrown value with no JSON form via String()', async () => {
    // A function JSON.stringify-es to undefined, exercising the `?? String(err)`
    // fallback (not the catch, which is for values that throw on stringify).
    const out = await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'boom', {})], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [
          make_tool({
            name: 'boom',
            input_schema: z.object({}),
            execute: () => {
              throw named_thrown
            },
          }),
        ],
      }),
    )
    expect(out.tool_calls[0]?.error?.message).toContain('named_thrown')
  })

  it('records approval requested then granted', async () => {
    const { trajectory, events } = recording_trajectory()
    const out = await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [make_tool({ name: 'echo', needs_approval: true, execute: () => 'ran' })],
        on_tool_approval: () => true,
        trajectory,
      }),
    )
    expect(out.tool_calls[0]?.output).toBe('ran')
    expect(events.find((e) => e['kind'] === 'tool_approval_requested')).toMatchObject({
      tool_name: 'echo',
      step_index: 0,
      tool_call_id: 'c1',
    })
    expect(events.find((e) => e['kind'] === 'tool_approval_granted')).toMatchObject({
      tool_name: 'echo',
      tool_call_id: 'c1',
    })
  })

  it('records a denial event when approval is refused', async () => {
    const { trajectory, events } = recording_trajectory()
    await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [make_tool({ name: 'echo', needs_approval: true })],
        on_tool_approval: () => false,
        trajectory,
      }),
    )
    expect(events.find((e) => e['kind'] === 'tool_approval_denied')).toMatchObject({
      tool_name: 'echo',
      tool_call_id: 'c1',
    })
  })

  it('fails closed with a descriptive error and denial record when no handler is set', async () => {
    const { trajectory, events } = recording_trajectory()
    let err: unknown
    try {
      await run_tool_loop(
        base_config({
          invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }],
          tools: [make_tool({ name: 'echo', needs_approval: true })],
          on_tool_approval: undefined,
          trajectory,
        }),
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(tool_approval_denied_error)
    expect((err as tool_approval_denied_error).message).toBe(
      "tool approval required for 'echo' but no on_tool_approval handler was provided",
    )
    expect((err as tool_approval_denied_error).tool_name).toBe('echo')
    expect(events.find((e) => e['kind'] === 'tool_approval_denied')).toBeDefined()
  })

  it('propagates a non-Error thrown by the approval handler as an Error', async () => {
    let err: unknown
    try {
      await run_tool_loop(
        base_config({
          invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }],
          tools: [make_tool({ name: 'echo', needs_approval: true })],
          // Async rejection routes through the promise's reject handler, which
          // wraps a non-Error into an Error.
          on_tool_approval: () => Promise.reject('approval-boom'),
        }),
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('approval-boom')
  })

  it('records tool_call/tool_result events and a chunk for an unknown tool (feed_back)', async () => {
    const { trajectory, events } = recording_trajectory()
    const chunks: StreamChunk[] = []
    await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'missing', { a: 1 })], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [make_tool({ name: 'echo' })],
        trajectory,
        dispatch_chunk: async (c) => {
          chunks.push(c)
        },
      }),
    )
    const msg = { message: "unknown tool 'missing'" }
    expect(events.find((e) => e['kind'] === 'tool_call')).toMatchObject({
      step_index: 0,
      name: 'missing',
      tool_call_id: 'c1',
      input: { a: 1 },
      error: msg,
    })
    expect(events.find((e) => e['kind'] === 'tool_result')).toMatchObject({ tool_call_id: 'c1', error: msg })
    expect(chunks.find((c) => c.kind === 'tool_result')).toMatchObject({ id: 'c1', step_index: 0, error: msg })
  })

  it('records the failure detail and chunk for a tool that throws (feed_back)', async () => {
    const { trajectory, events } = recording_trajectory()
    const chunks: StreamChunk[] = []
    const out = await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'boom', {})], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [
          make_tool({
            name: 'boom',
            input_schema: z.object({}),
            execute: () => {
              throw new Error('exploded')
            },
          }),
        ],
        trajectory,
        dispatch_chunk: async (c) => {
          chunks.push(c)
        },
      }),
    )
    expect(out.tool_calls[0]?.error?.message).toBe('exploded')
    expect(events.find((e) => e['kind'] === 'tool_call')).toMatchObject({
      name: 'boom',
      tool_call_id: 'c1',
      error: { message: 'exploded' },
    })
    expect(events.find((e) => e['kind'] === 'tool_result')).toMatchObject({
      tool_call_id: 'c1',
      error: { message: 'exploded' },
    })
    expect(chunks.find((c) => c.kind === 'tool_result')).toMatchObject({ id: 'c1', error: { message: 'exploded' } })
  })

  it('throws tool_approval_denied_error with the canonical message under throw policy', async () => {
    let err: unknown
    try {
      await run_tool_loop(
        base_config({
          invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }],
          tools: [make_tool({ name: 'echo', needs_approval: true })],
          on_tool_approval: () => false,
          tool_error_policy: 'throw',
        }),
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(tool_approval_denied_error)
    expect((err as tool_approval_denied_error).message).toBe("tool 'echo' approval denied")
    expect((err as tool_approval_denied_error).tool_call_id).toBe('c1')
  })

  it('throws tool_error with metadata for an unknown tool under throw policy', async () => {
    let err: unknown
    try {
      await run_tool_loop(
        base_config({
          invoke: [{ tool_calls: [call('c1', 'missing', {})], finish_reason: 'tool_calls' }],
          tools: [make_tool({ name: 'echo' })],
          tool_error_policy: 'throw',
        }),
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(tool_error)
    expect((err as tool_error).message).toBe("unknown tool 'missing'")
    expect((err as tool_error).tool_name).toBe('missing')
    expect((err as tool_error).tool_call_id).toBe('c1')
  })

  it('records tool_call/tool_result events and a chunk for invalid input (feed_back)', async () => {
    const { trajectory, events } = recording_trajectory()
    const chunks: StreamChunk[] = []
    await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'echo', { value: 123 })], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [make_tool({ name: 'echo', input_schema: z.object({ value: z.string() }) })],
        trajectory,
        dispatch_chunk: async (c) => {
          chunks.push(c)
        },
      }),
    )
    const tc = events.find((e) => e['kind'] === 'tool_call')
    expect(tc).toMatchObject({ name: 'echo', tool_call_id: 'c1', input: { value: 123 } })
    expect(String((tc as { error?: { message?: string } })?.error?.message)).toMatch(/^invalid tool input: /)
    expect(events.find((e) => e['kind'] === 'tool_result')?.['tool_call_id']).toBe('c1')
    expect(chunks.find((c) => c.kind === 'tool_result')?.id).toBe('c1')
  })

  it('records tool_call/tool_result events and a chunk for a denied tool (feed_back)', async () => {
    const { trajectory, events } = recording_trajectory()
    const chunks: StreamChunk[] = []
    await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }, { text: 'done' }],
        tools: [make_tool({ name: 'echo', needs_approval: true })],
        on_tool_approval: () => false,
        trajectory,
        dispatch_chunk: async (c) => {
          chunks.push(c)
        },
      }),
    )
    const denied = { message: 'tool_approval_denied' }
    expect(events.find((e) => e['kind'] === 'tool_call')).toMatchObject({
      name: 'echo',
      tool_call_id: 'c1',
      input: { value: 'x' },
      error: denied,
    })
    expect(events.find((e) => e['kind'] === 'tool_result')).toMatchObject({ tool_call_id: 'c1', error: denied })
    expect(chunks.find((c) => c.kind === 'tool_result')).toMatchObject({ id: 'c1', error: denied })
  })

  it('records and dispatches an unexecuted tool call when max_steps would be exceeded', async () => {
    const { trajectory, events } = recording_trajectory()
    const chunks: StreamChunk[] = []
    let executed = false
    await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' }],
        tools: [
          make_tool({
            name: 'echo',
            execute: () => {
              executed = true
              return 'ok'
            },
          }),
        ],
        max_steps: 1,
        trajectory,
        dispatch_chunk: async (c) => {
          chunks.push(c)
        },
      }),
    )
    const msg = { message: 'max_steps_exceeded_before_execution' }
    expect(executed).toBe(false)
    expect(events.find((e) => e['kind'] === 'tool_result')).toMatchObject({ tool_call_id: 'c1', error: msg })
    expect(chunks.find((c) => c.kind === 'tool_result')).toMatchObject({ id: 'c1', error: msg })
  })

  it('stops immediately with max_steps when starting at the step ceiling', async () => {
    let invoked = false
    const invoke: InvokeOnce = async () => {
      invoked = true
      return { text: 'x', tool_calls: [], finish_reason: 'stop', usage: zero_usage }
    }
    const out = await run_tool_loop({
      ...base_config({ invoke: [{}] }),
      invoke_once: invoke,
      max_steps: 3,
      step_index_start: 3,
    })
    expect(invoked).toBe(false)
    expect(out.max_steps_reached).toBe(true)
    expect(out.finish_reason).toBe('max_steps')
    expect(out.steps).toHaveLength(0)
  })

  it('emits a pricing_missing event when pricing is unavailable for a paid provider', async () => {
    const emitted: Array<{ provider: string; model_id: string }> = []
    const dedup = {
      emit: (provider: string, model_id: string) => {
        emitted.push({ provider, model_id })
      },
    }
    await run_tool_loop(
      base_config({
        invoke: [{ text: 'done' }],
        provider: 'anthropic',
        model_id: 'claude-opus-4-7',
        resolve_pricing: () => undefined,
        pricing_dedup: dedup,
      }),
    )
    expect(emitted).toEqual([{ provider: 'anthropic', model_id: 'claude-opus-4-7' }])
  })
})

const hermes = (value: string): string =>
  `<tool_call>{"name":"echo","arguments":{"value":"${value}"}}</tool_call>`

function capturing_echo(seen: unknown[]): Tool {
  return make_tool({
    name: 'echo',
    execute: (input: unknown) => {
      seen.push(input)
      return 'ran'
    },
  })
}

describe('run_tool_loop tool-call salvage', () => {
  it('does not salvage when no budget is configured (fall-through parity)', async () => {
    const seen: unknown[] = []
    const messages: Message[] = [{ role: 'user', content: 'go' }]
    const out = await run_tool_loop(
      base_config({
        invoke: [{ text: hermes('hi'), finish_reason: 'stop' }],
        tools: [capturing_echo(seen)],
        messages,
      }),
    )
    expect(seen).toEqual([])
    expect(out.finish_reason).toBe('stop')
    expect(out.text).toBe(hermes('hi'))
    expect(out.steps[0]?.tool_calls).toEqual([])
    expect(messages[1]).toEqual({ role: 'assistant', content: hermes('hi') })
  })

  it('salvages a hermes call: executes it, rewrites history, marks the record', async () => {
    const seen: unknown[] = []
    const budget = { remaining: 1 }
    const messages: Message[] = [{ role: 'user', content: 'go' }]
    const { trajectory, events } = recording_trajectory()
    const raw = `Let me help.\n${hermes('hi')}`
    const out = await run_tool_loop(
      base_config({
        invoke: [{ text: raw, finish_reason: 'stop' }, { text: 'done' }],
        tools: [capturing_echo(seen)],
        messages,
        trajectory,
        salvage_budget: budget,
      }),
    )
    expect(seen).toEqual([{ value: 'hi' }])
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me help.' },
        { type: 'tool_call', id: 'salvaged_0_0', name: 'echo', input: { value: 'hi' } },
      ],
    })
    expect(tool_message(messages)).toMatchObject({ role: 'tool', tool_call_id: 'salvaged_0_0' })
    expect(out.steps[0]?.text).toBe(raw)
    expect(out.steps[0]?.finish_reason).toBe('tool_calls')
    expect(out.tool_calls[0]).toMatchObject({ salvaged: true, salvaged_format: 'hermes' })
    expect(events.find((e) => e['kind'] === 'tool_call_salvaged')).toMatchObject({
      step_index: 0,
      calls: [{ tool_call_id: 'salvaged_0_0', name: 'echo', format: 'hermes' }],
      raw_text: raw,
    })
    expect(budget.remaining).toBe(0)
  })

  it('stops without salvaging once the shared budget is exhausted', async () => {
    const seen: unknown[] = []
    const budget = { remaining: 1 }
    const out = await run_tool_loop(
      base_config({
        invoke: [
          { text: hermes('one'), finish_reason: 'stop' },
          { text: hermes('two'), finish_reason: 'stop' },
        ],
        tools: [capturing_echo(seen)],
        salvage_budget: budget,
      }),
    )
    expect(seen).toEqual([{ value: 'one' }])
    expect(out.finish_reason).toBe('stop')
    expect(out.text).toBe(hermes('two'))
    expect(budget.remaining).toBe(0)
  })

  it('does not spend budget when the scan finds no valid call', async () => {
    const budget = { remaining: 2 }
    const raw = '<tool_call>{"name":"missing","arguments":{"value":"hi"}}</tool_call>'
    const out = await run_tool_loop(
      base_config({
        invoke: [{ text: raw, finish_reason: 'stop' }],
        tools: [make_tool()],
        salvage_budget: budget,
      }),
    )
    expect(out.finish_reason).toBe('stop')
    expect(out.text).toBe(raw)
    expect(budget.remaining).toBe(2)
  })

  it('salvages a length-truncated turn', async () => {
    const seen: unknown[] = []
    const out = await run_tool_loop(
      base_config({
        invoke: [{ text: hermes('hi'), finish_reason: 'length' }, { text: 'done' }],
        tools: [capturing_echo(seen)],
        salvage_budget: { remaining: 1 },
      }),
    )
    expect(seen).toEqual([{ value: 'hi' }])
    expect(out.steps[0]?.finish_reason).toBe('tool_calls')
  })

  it('does not salvage when no tools are registered', async () => {
    const out = await run_tool_loop(
      base_config({
        invoke: [{ text: hermes('hi'), finish_reason: 'stop' }],
        tools: [],
        salvage_budget: { remaining: 1 },
      }),
    )
    expect(out.finish_reason).toBe('stop')
    expect(out.text).toBe(hermes('hi'))
  })

  it('leaves native structured calls and the budget untouched', async () => {
    const seen: unknown[] = []
    const budget = { remaining: 1 }
    const out = await run_tool_loop(
      base_config({
        invoke: [
          { tool_calls: [call('c1', 'echo', { value: 'x' })], finish_reason: 'tool_calls' },
          { text: 'done' },
        ],
        tools: [capturing_echo(seen)],
        salvage_budget: budget,
      }),
    )
    expect(seen).toEqual([{ value: 'x' }])
    expect(out.tool_calls[0]?.salvaged).toBeUndefined()
    expect(budget.remaining).toBe(1)
  })

  it('routes a salvaged call through approval with the salvaged id', async () => {
    const budget = { remaining: 1 }
    const { trajectory, events } = recording_trajectory()
    let captured: unknown
    await run_tool_loop(
      base_config({
        invoke: [{ text: hermes('hi'), finish_reason: 'stop' }, { text: 'done' }],
        tools: [make_tool({ name: 'echo', needs_approval: true, execute: () => 'ran' })],
        on_tool_approval: (req) => {
          captured = req.input
          return true
        },
        trajectory,
        salvage_budget: budget,
      }),
    )
    expect(captured).toEqual({ value: 'hi' })
    expect(events.find((e) => e['kind'] === 'tool_approval_requested')).toMatchObject({
      tool_call_id: 'salvaged_0_0',
    })
  })

  it('marks a salvaged call unexecuted when it lands on the final step', async () => {
    const budget = { remaining: 1 }
    const out = await run_tool_loop(
      base_config({
        invoke: [{ text: hermes('hi'), finish_reason: 'stop' }],
        tools: [make_tool()],
        max_steps: 1,
        salvage_budget: budget,
      }),
    )
    expect(out.finish_reason).toBe('max_steps')
    expect(out.tool_calls[0]).toMatchObject({
      error: { message: 'max_steps_exceeded_before_execution' },
      salvaged: true,
      salvaged_format: 'hermes',
    })
    expect(budget.remaining).toBe(0)
  })

  it('dispatches synthetic start/end chunks before the tool_result for a salvaged call', async () => {
    const chunks: StreamChunk[] = []
    await run_tool_loop(
      base_config({
        invoke: [{ text: hermes('hi'), finish_reason: 'stop' }, { text: 'done' }],
        tools: [make_tool()],
        salvage_budget: { remaining: 1 },
        dispatch_chunk: async (c) => {
          chunks.push(c)
        },
      }),
    )
    const relevant = chunks
      .filter((c) => 'id' in c && c.id === 'salvaged_0_0')
      .map((c) => c.kind)
    expect(relevant).toEqual(['tool_call_start', 'tool_call_end', 'tool_result'])
  })
})

describe('run_tool_loop max_tool_calls_per_step clamp', () => {
  it('executes the first N native calls and drops the rest', async () => {
    const order: string[] = []
    const mk = (name: string): Tool =>
      make_tool({
        name,
        execute: () => {
          order.push(name)
          return name.toUpperCase()
        },
      })
    const messages: Message[] = [{ role: 'user', content: 'go' }]
    const { trajectory, events } = recording_trajectory()
    const out = await run_tool_loop(
      base_config({
        invoke: [
          {
            tool_calls: [
              call('c1', 'a', { value: '1' }),
              call('c2', 'b', { value: '2' }),
              call('c3', 'c', { value: '3' }),
            ],
            finish_reason: 'tool_calls',
          },
          { text: 'done' },
        ],
        tools: [mk('a'), mk('b'), mk('c')],
        messages,
        trajectory,
        max_tool_calls_per_step: 2,
      }),
    )
    expect(order).toEqual(['a', 'b'])
    const assistant = messages[1]
    const parts = Array.isArray(assistant?.content) ? assistant.content : []
    expect(parts.filter((p) => p.type === 'tool_call')).toHaveLength(2)
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2)
    const dropped = out.tool_calls.find((tc) => tc.id === 'c3')
    expect(dropped).toMatchObject({
      error: { message: 'dropped_max_tool_calls_per_step' },
      duration_ms: 0,
    })
    expect(events.find((e) => e['kind'] === 'tool_calls_dropped')).toMatchObject({
      step_index: 0,
      max_tool_calls_per_step: 2,
      kept: 2,
      dropped: [{ tool_call_id: 'c3', name: 'c' }],
    })
    expect(
      events
        .filter((e) => e['kind'] === 'tool_call')
        .map((e) => e['tool_call_id']),
    ).toEqual(['c1', 'c2'])
    const dropped_result = events.find(
      (e) => e['kind'] === 'tool_result' && e['tool_call_id'] === 'c3',
    )
    expect(dropped_result).toMatchObject({ error: { message: 'dropped_max_tool_calls_per_step' } })
    expect(out.finish_reason).toBe('stop')
  })

  it('clamps salvaged calls and flags the dropped one', async () => {
    const seen: unknown[] = []
    const budget = { remaining: 1 }
    const out = await run_tool_loop(
      base_config({
        invoke: [
          { text: `${hermes('a')}${hermes('b')}`, finish_reason: 'stop' },
          { text: 'done' },
        ],
        tools: [capturing_echo(seen)],
        salvage_budget: budget,
        max_tool_calls_per_step: 1,
      }),
    )
    expect(seen).toEqual([{ value: 'a' }])
    expect(out.tool_calls.find((tc) => tc.id === 'salvaged_0_1')).toMatchObject({
      error: { message: 'dropped_max_tool_calls_per_step' },
      salvaged: true,
      salvaged_format: 'hermes',
    })
    expect(budget.remaining).toBe(0)
  })

  it('does not drop or emit an event when the count equals the cap', async () => {
    const { trajectory, events } = recording_trajectory()
    const out = await run_tool_loop(
      base_config({
        invoke: [
          {
            tool_calls: [call('c1', 'echo', { value: '1' }), call('c2', 'echo', { value: '2' })],
            finish_reason: 'tool_calls',
          },
          { text: 'done' },
        ],
        tools: [make_tool()],
        trajectory,
        max_tool_calls_per_step: 2,
      }),
    )
    expect(out.tool_calls).toHaveLength(2)
    expect(events.find((e) => e['kind'] === 'tool_calls_dropped')).toBeUndefined()
  })

  it('leaves all calls when no cap is set', async () => {
    const { trajectory, events } = recording_trajectory()
    const out = await run_tool_loop(
      base_config({
        invoke: [
          {
            tool_calls: [call('c1', 'echo', { value: '1' }), call('c2', 'echo', { value: '2' })],
            finish_reason: 'tool_calls',
          },
          { text: 'done' },
        ],
        tools: [make_tool()],
        trajectory,
      }),
    )
    expect(out.tool_calls).toHaveLength(2)
    expect(events.find((e) => e['kind'] === 'tool_calls_dropped')).toBeUndefined()
  })
})

describe('run_tool_loop ends_turn (terminal tool)', () => {
  const finish_tool = (overrides: Partial<Tool> = {}): Tool =>
    make_tool({ name: 'finish', ends_turn: true, execute: () => 'summary', ...overrides })

  it('ends the loop when a terminal tool executes successfully', async () => {
    // Exactly one invoke result: if the loop ran another turn, make_invoke_once
    // throws, so this also proves the loop stopped.
    const out = await run_tool_loop(
      base_config({
        invoke: [
          { text: 'wrapping up', tool_calls: [call('c1', 'finish', { value: 'x' })], finish_reason: 'tool_calls' },
        ],
        tools: [finish_tool()],
      }),
    )
    expect(out.finish_reason).toBe('stop')
    expect(out.max_steps_reached).toBe(false)
    expect(out.text).toBe('wrapping up')
    expect(out.steps).toHaveLength(1)
    expect(out.steps[0]?.finish_reason).toBe('tool_calls')
    expect(out.tool_calls).toHaveLength(1)
    expect(out.tool_calls[0]).toMatchObject({ name: 'finish', output: 'summary' })
    expect(out.tool_calls[0]?.error).toBeUndefined()
  })

  it('executes the terminal call normally: output, fed result, trajectory events, and chunk', async () => {
    const chunks: StreamChunk[] = []
    const { trajectory, events } = recording_trajectory()
    const messages: Message[] = [{ role: 'user', content: 'go' }]
    await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'finish', { value: 'x' })], finish_reason: 'tool_calls' }],
        tools: [finish_tool()],
        messages,
        trajectory,
        dispatch_chunk: async (c) => {
          chunks.push(c)
        },
      }),
    )
    expect(messages[1]).toMatchObject({ role: 'assistant' })
    expect(tool_message(messages)).toMatchObject({ role: 'tool', name: 'finish', content: 'summary' })
    expect(events.find((e) => e['kind'] === 'tool_call')).toMatchObject({ tool_call_id: 'c1', name: 'finish' })
    expect(events.find((e) => e['kind'] === 'tool_result')).toMatchObject({ tool_call_id: 'c1', output: 'summary' })
    expect(chunks.find((c) => c.kind === 'tool_result')).toMatchObject({ id: 'c1', step_index: 0, output: 'summary' })
  })

  it('executes every kept call in the step before breaking, even when the terminal call is first', async () => {
    const order: string[] = []
    const out = await run_tool_loop(
      base_config({
        invoke: [
          {
            tool_calls: [call('c1', 'finish', { value: 'x' }), call('c2', 'echo', { value: 'y' })],
            finish_reason: 'tool_calls',
          },
        ],
        tools: [
          finish_tool({
            execute: () => {
              order.push('finish')
              return 'summary'
            },
          }),
          make_tool({
            name: 'echo',
            execute: () => {
              order.push('echo')
              return 'echoed'
            },
          }),
        ],
      }),
    )
    expect(order).toEqual(['finish', 'echo'])
    expect(out.finish_reason).toBe('stop')
    expect(out.tool_calls).toHaveLength(2)
  })

  it('wins over max_steps when the terminal call lands on the final allowed step', async () => {
    const out = await run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'finish', { value: 'x' })], finish_reason: 'tool_calls' }],
        tools: [finish_tool()],
        max_steps: 1,
      }),
    )
    expect(out.finish_reason).toBe('stop')
    expect(out.max_steps_reached).toBe(false)
    expect(out.steps[0]?.finish_reason).toBe('tool_calls')
    expect(out.tool_calls[0]).toMatchObject({ name: 'finish', output: 'summary' })
    expect(out.tool_calls[0]?.error).toBeUndefined()
  })

  it('ends the loop for a salvaged terminal call', async () => {
    const out = await run_tool_loop(
      base_config({
        invoke: [{ text: hermes('hi'), finish_reason: 'stop' }],
        tools: [make_tool({ name: 'echo', ends_turn: true, execute: () => 'ran' })],
        salvage_budget: { remaining: 1 },
      }),
    )
    expect(out.finish_reason).toBe('stop')
    expect(out.tool_calls[0]).toMatchObject({ output: 'ran', salvaged: true, salvaged_format: 'hermes' })
  })

  it('wins over max_steps for a salvaged terminal call on the final step', async () => {
    const budget = { remaining: 1 }
    const out = await run_tool_loop(
      base_config({
        invoke: [{ text: hermes('hi'), finish_reason: 'stop' }],
        tools: [make_tool({ name: 'echo', ends_turn: true, execute: () => 'ran' })],
        max_steps: 1,
        salvage_budget: budget,
      }),
    )
    expect(out.finish_reason).toBe('stop')
    expect(out.max_steps_reached).toBe(false)
    expect(out.steps[0]?.finish_reason).toBe('tool_calls')
    expect(out.tool_calls[0]).toMatchObject({ output: 'ran', salvaged: true })
    expect(out.tool_calls[0]?.error).toBeUndefined()
    expect(budget.remaining).toBe(0)
  })

  it('does not end the loop when a terminal call throws (feed_back)', async () => {
    const out = await run_tool_loop(
      base_config({
        invoke: [
          { tool_calls: [call('c1', 'finish', { value: 'x' })], finish_reason: 'tool_calls' },
          { text: 'recovered', finish_reason: 'stop' },
        ],
        tools: [finish_tool({ execute: () => { throw new Error('kaboom') } })],
      }),
    )
    expect(out.steps).toHaveLength(2)
    expect(out.text).toBe('recovered')
    expect(out.tool_calls[0]?.error).toEqual({ message: 'kaboom' })
  })

  it('propagates the throw (does not terminate) when a terminal call throws under throw policy', async () => {
    await expect(
      run_tool_loop(
        base_config({
          invoke: [{ tool_calls: [call('c1', 'finish', { value: 'x' })], finish_reason: 'tool_calls' }],
          tools: [finish_tool({ execute: () => { throw new Error('kaboom') } })],
          tool_error_policy: 'throw',
        }),
      ),
    ).rejects.toBeInstanceOf(tool_error)
  })

  it('does not end the loop when a terminal call is denied (feed_back)', async () => {
    const out = await run_tool_loop(
      base_config({
        invoke: [
          { tool_calls: [call('c1', 'finish', { value: 'x' })], finish_reason: 'tool_calls' },
          { text: 'moved on', finish_reason: 'stop' },
        ],
        tools: [finish_tool({ needs_approval: true })],
        on_tool_approval: () => false,
      }),
    )
    expect(out.steps).toHaveLength(2)
    expect(out.text).toBe('moved on')
    expect(out.tool_calls[0]?.error).toEqual({ message: 'tool_approval_denied' })
  })

  it('propagates the denial (does not terminate) when a terminal call is denied under throw policy', async () => {
    await expect(
      run_tool_loop(
        base_config({
          invoke: [{ tool_calls: [call('c1', 'finish', { value: 'x' })], finish_reason: 'tool_calls' }],
          tools: [finish_tool({ needs_approval: true })],
          on_tool_approval: () => false,
          tool_error_policy: 'throw',
        }),
      ),
    ).rejects.toBeInstanceOf(tool_approval_denied_error)
  })

  it('does not end the loop when a terminal call has invalid input (execute never runs)', async () => {
    let executed = false
    const out = await run_tool_loop(
      base_config({
        invoke: [
          { tool_calls: [call('c1', 'finish', { wrong: 1 })], finish_reason: 'tool_calls' },
          { text: 'retry', finish_reason: 'stop' },
        ],
        tools: [
          finish_tool({
            execute: () => {
              executed = true
              return 'summary'
            },
          }),
        ],
      }),
    )
    expect(executed).toBe(false)
    expect(out.steps).toHaveLength(2)
    expect(out.tool_calls[0]?.error?.message).toContain('invalid tool input')
  })

  it('does not end the loop when a terminal call is dropped by max_tool_calls_per_step', async () => {
    const out = await run_tool_loop(
      base_config({
        invoke: [
          {
            tool_calls: [call('c1', 'echo', { value: 'y' }), call('c2', 'finish', { value: 'x' })],
            finish_reason: 'tool_calls',
          },
          { text: 'kept going', finish_reason: 'stop' },
        ],
        tools: [make_tool({ name: 'echo', execute: () => 'echoed' }), finish_tool()],
        max_tool_calls_per_step: 1,
      }),
    )
    expect(out.steps).toHaveLength(2)
    expect(out.text).toBe('kept going')
    const dropped = out.tool_calls.find((r) => r.id === 'c2')
    expect(dropped?.error).toEqual({ message: 'dropped_max_tool_calls_per_step' })
  })

  it('treats ends_turn: false like undefined (does not terminate)', async () => {
    const out = await run_tool_loop(
      base_config({
        invoke: [
          { tool_calls: [call('c1', 'echo', { value: 'y' })], finish_reason: 'tool_calls' },
          { text: 'done', finish_reason: 'stop' },
        ],
        tools: [make_tool({ name: 'echo', ends_turn: false, execute: () => 'echoed' })],
      }),
    )
    expect(out.steps).toHaveLength(2)
    expect(out.text).toBe('done')
    expect(out.tool_calls[0]).toMatchObject({ output: 'echoed' })
  })
})

describe('run_tool_loop helpers (step 4)', () => {
  it('aborts at a turn boundary with the exact message and no in-flight tool', async () => {
    const controller = new AbortController()
    controller.abort(new Error('boundary cancel'))
    let err: unknown
    try {
      await run_tool_loop(base_config({ invoke: [{ text: 'x' }], abort: controller.signal }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    expect((err as aborted_error).reason).toBeInstanceOf(Error)
    // The boundary guard carries no tool_call_in_flight (no tool was dispatching).
    expect((err as aborted_error).tool_call_in_flight).toBeUndefined()
  })

  it('aborts in-flight with the tool identity when a prior tool cancels', async () => {
    const controller = new AbortController()
    const tool = make_tool({
      name: 'echo',
      execute: (input: unknown) => {
        if ((input as { value: string }).value === 'a') controller.abort(new Error('mid'))
        return 'ok'
      },
    })
    let err: unknown
    try {
      await run_tool_loop(
        base_config({
          invoke: [
            {
              tool_calls: [call('a', 'echo', { value: 'a' }), call('b', 'echo', { value: 'b' })],
              finish_reason: 'tool_calls',
            },
          ],
          tools: [tool],
          abort: controller.signal,
        }),
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    // The second tool's pre-dispatch guard names it as in-flight.
    expect((err as aborted_error).tool_call_in_flight).toEqual({ id: 'b', name: 'echo' })
  })

  it('records the tool_approval_denied event payload when failing closed', async () => {
    const { trajectory, events } = recording_trajectory()
    await expect(
      run_tool_loop(
        base_config({
          invoke: [{ tool_calls: [call('c1', 'danger', { value: 'x' })], finish_reason: 'tool_calls' }],
          tools: [make_tool({ name: 'danger', needs_approval: true })],
          on_tool_approval: undefined,
          trajectory,
        }),
      ),
    ).rejects.toBeInstanceOf(tool_approval_denied_error)
    const denied = events.find((e) => e['kind'] === 'tool_approval_denied')
    expect(denied).toMatchObject({ tool_name: 'danger', step_index: 0, tool_call_id: 'c1' })
  })

  it('aborts approval synchronously when the signal is already aborted on entry', async () => {
    const controller = new AbortController()
    const tool = make_tool({
      name: 'danger',
      // needs_approval fires before the approval race; aborting here means the
      // signal is already aborted when the wait promise is constructed.
      needs_approval: () => {
        controller.abort(new Error('cancel-in-needs'))
        return true
      },
    })
    let err: unknown
    try {
      await run_tool_loop(
        base_config({
          invoke: [{ tool_calls: [call('c1', 'danger', { value: 'x' })], finish_reason: 'tool_calls' }],
          tools: [tool],
          on_tool_approval: () => new Promise<boolean>(() => {}),
          abort: controller.signal,
        }),
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    expect(((err as aborted_error).reason as Error).message).toBe('cancel-in-needs')
  })

  it('aborts during an approval wait with the exact message and reason', async () => {
    const controller = new AbortController()
    const promise = run_tool_loop(
      base_config({
        invoke: [{ tool_calls: [call('c1', 'danger', { value: 'x' })], finish_reason: 'tool_calls' }],
        tools: [make_tool({ name: 'danger', needs_approval: true })],
        on_tool_approval: () => new Promise<boolean>(() => {}),
        abort: controller.signal,
      }),
    )
    setTimeout(() => controller.abort(new Error('wait cancel')), 15)
    let err: unknown
    try {
      await promise
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    expect(((err as aborted_error).reason as Error).message).toBe('wait cancel')
  })

  it('carries the tool output on the streamed tool_result chunk', async () => {
    const chunks: StreamChunk[] = []
    await run_tool_loop(
      base_config({
        invoke: [
          { tool_calls: [call('c1', 'echo', { value: 'hi' })], finish_reason: 'tool_calls' },
          { text: 'done', finish_reason: 'stop' },
        ],
        tools: [make_tool({ name: 'echo', execute: () => 'the-output' })],
        stream: true,
        dispatch_chunk: async (c) => {
          chunks.push(c)
        },
      }),
    )
    const tool_result = chunks.find((c) => c.kind === 'tool_result')
    expect(tool_result).toMatchObject({ id: 'c1', output: 'the-output' })
    expect('error' in (tool_result as object)).toBe(false)
  })

  it('carries the error on the streamed tool_result chunk when execute throws', async () => {
    const chunks: StreamChunk[] = []
    await run_tool_loop(
      base_config({
        invoke: [
          { tool_calls: [call('c1', 'boom', { value: 'x' })], finish_reason: 'tool_calls' },
          { text: 'done', finish_reason: 'stop' },
        ],
        tools: [
          make_tool({
            name: 'boom',
            execute: () => {
              throw new Error('kaboom')
            },
          }),
        ],
        tool_error_policy: 'feed_back',
        stream: true,
        dispatch_chunk: async (c) => {
          chunks.push(c)
        },
      }),
    )
    const tool_result = chunks.find((c) => c.kind === 'tool_result')
    expect((tool_result as { error?: { message: string } }).error?.message).toContain('kaboom')
    expect('output' in (tool_result as object)).toBe(false)
  })

  it('falls back to String() when a tool result cannot be JSON-serialized', async () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    let turn2_messages: ReadonlyArray<Message> = []
    let call_n = 0
    const invoke_once: InvokeOnce = async (args) => {
      call_n += 1
      if (call_n === 1) {
        return {
          text: '',
          tool_calls: [call('c1', 'echo', { value: 'x' })],
          finish_reason: 'tool_calls',
          usage: zero_usage,
        }
      }
      turn2_messages = args.messages
      return { text: 'done', tool_calls: [], finish_reason: 'stop', usage: zero_usage }
    }
    await run_tool_loop({
      ...base_config({ invoke: [] }),
      invoke_once,
      tools: [make_tool({ name: 'echo', execute: () => circular })],
    })
    const tool_msg = turn2_messages.find((m) => m.role === 'tool')
    // JSON.stringify throws on the circular ref, so the catch returns String(value).
    expect(tool_msg?.content).toBe('[object Object]')
  })

  it('records a cost breakdown when pricing resolves for the step', async () => {
    const { trajectory, events } = recording_trajectory()
    await run_tool_loop(
      base_config({
        invoke: [{ text: 'hi', finish_reason: 'stop', usage: { input_tokens: 1000, output_tokens: 500 } }],
        trajectory,
        resolve_pricing: () => ({ input_per_million: 3, output_per_million: 15 }),
      }),
    )
    const cost_event = events.find((e) => e['kind'] === 'cost')
    expect(cost_event).toBeDefined()
    expect(cost_event?.['source']).toBe('engine_derived')
  })
})
