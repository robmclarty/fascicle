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
