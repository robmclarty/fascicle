/**
 * prepare_step loop hook (D6, Step 8).
 *
 * Two layers of proof, mirroring how turn-timeout was proven across both
 * depth-1 transports:
 *
 *   1. Direct run_tool_loop unit tests with a mock invoke_once seam. This is
 *      the exact code BOTH transports route through (build_native_invoke and
 *      build_ai_sdk_invoke each receive InvokeOnceArgs.messages from the loop),
 *      so the substitution and canonical-transcript invariants proven here hold
 *      for either transport. (The ai_sdk path is additionally pinned
 *      empirically in generate.test.ts.)
 *   2. Loop-inheritance tests driving the real engine.generate path through an
 *      in-memory fake native adapter (the native_loop_inheritance.test.ts
 *      model): pruning each turn must NOT disturb salvage, approval,
 *      Tool.ends_turn, or schema-repair, because those read the canonical
 *      transcript the hook never touches.
 *
 * Assertions are concrete values (exact message arrays, exact event payloads),
 * not smoke.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import { create_engine } from '../create_engine.js'
import {
  run_tool_loop,
  type InvokeOnce,
  type InvokeOnceArgs,
  type InvokeOnceResult,
  type ToolLoopConfig,
} from '../tool_loop.js'
import { create_pricing_missing_dedup } from '../trajectory.js'
import type { ProviderFactory } from '../providers/types.js'
import type {
  EngineConfig,
  Message,
  PrepareStepHook,
  Tool,
  TurnRequest,
  TurnResult,
  UsageTotals,
} from '../types.js'

const zero_usage: UsageTotals = { input_tokens: 0, output_tokens: 0 }

// ---------------------------------------------------------------------------
// Layer 1: direct run_tool_loop unit tests (transport-agnostic seam).
// ---------------------------------------------------------------------------

/** invoke_once that records the messages it was handed on each turn. */
function capturing_invoke_once(
  results: ReadonlyArray<Partial<InvokeOnceResult>>,
  captured: Array<ReadonlyArray<Message>>,
): InvokeOnce {
  let call = 0
  return async (args: InvokeOnceArgs): Promise<InvokeOnceResult> => {
    // Snapshot at send time: on a no-op the loop hands back the live canonical
    // array by reference and then grows it, so a snapshot is what "what was
    // sent this turn" means.
    captured.push([...args.messages])
    const r = results[call]
    call += 1
    if (r === undefined) {
      throw new Error(`invoke_once called ${call} times, only ${results.length} results supplied`)
    }
    return {
      text: r.text ?? '',
      tool_calls: r.tool_calls ?? [],
      finish_reason: r.finish_reason ?? 'stop',
      usage: r.usage ?? zero_usage,
    }
  }
}

function echo_tool(): Tool {
  return {
    name: 'echo',
    description: 'echo',
    input_schema: z.object({ value: z.string() }),
    execute: (input: unknown) => `echo:${(input as { value: string }).value}`,
  }
}

function recording_trajectory(): {
  trajectory: TrajectoryLogger
  events: TrajectoryEvent[]
} {
  const events: TrajectoryEvent[] = []
  let id = 0
  const trajectory: TrajectoryLogger = {
    record: (e) => {
      events.push(e)
    },
    start_span: (name) => {
      id += 1
      events.push({ kind: 'span_start', name })
      return `s${id}`
    },
    end_span: () => {},
  }
  return { trajectory, events }
}

function base_config(
  overrides: Partial<Omit<ToolLoopConfig, 'invoke_once'>> & { invoke_once: InvokeOnce },
): ToolLoopConfig {
  return {
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
    model_id: 'm-1',
    resolve_pricing: () => undefined,
    pricing_dedup: create_pricing_missing_dedup(undefined),
    ...overrides,
  }
}

/** Windows the first turn to two messages, then no-ops. Module-scoped so it
 * captures nothing (lint: consistent-function-scoping). */
const prune_first_turn: PrepareStepHook = (ctx) =>
  ctx.step_index === 0
    ? {
        messages: [
          { role: 'system', content: 'window' },
          { role: 'user', content: 'go' },
        ],
      }
    : undefined

describe('prepare_step in run_tool_loop', () => {
  it('replaces the request for that turn only while the canonical transcript keeps accumulating', async () => {
    const captured: Array<ReadonlyArray<Message>> = []
    const hook_saw: Array<{ step_index: number; messages: Message[] }> = []
    const messages: Message[] = [{ role: 'user', content: 'go' }]
    const prepare_step: PrepareStepHook = (ctx) => {
      hook_saw.push({ step_index: ctx.step_index, messages: [...ctx.messages] })
      return { messages: [{ role: 'user', content: `pruned@${ctx.step_index}` }] }
    }

    const result = await run_tool_loop(
      base_config({
        invoke_once: capturing_invoke_once(
          [
            { tool_calls: [{ id: 'c1', name: 'echo', input: { value: 'hi' } }], finish_reason: 'tool_calls' },
            { text: 'done', finish_reason: 'stop' },
          ],
          captured,
        ),
        messages,
        tools: [echo_tool()],
        prepare_step,
      }),
    )

    expect(result.text).toBe('done')

    // invoke_once received the ephemeral pruned array each turn, never the
    // canonical transcript.
    expect(captured).toEqual([
      [{ role: 'user', content: 'pruned@0' }],
      [{ role: 'user', content: 'pruned@1' }],
    ])

    // The hook saw the would-be request messages: the seed on turn 0, then the
    // full grown transcript (assistant tool_call + fed tool result) on turn 1.
    expect(hook_saw[0]).toEqual({ step_index: 0, messages: [{ role: 'user', content: 'go' }] })
    expect(hook_saw[1]).toEqual({
      step_index: 1,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c1', name: 'echo', input: { value: 'hi' } }],
        },
        { role: 'tool', tool_call_id: 'c1', name: 'echo', content: 'echo:hi' },
      ],
    })

    // The canonical array the loop appends to is the real, un-pruned history.
    expect(messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'echo', input: { value: 'hi' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'echo', content: 'echo:hi' },
      { role: 'assistant', content: 'done' },
    ])
  })

  it('is a no-op when the hook returns undefined (canonical sent, no event)', async () => {
    const captured: Array<ReadonlyArray<Message>> = []
    const { trajectory, events } = recording_trajectory()
    await run_tool_loop(
      base_config({
        invoke_once: capturing_invoke_once([{ text: 'hi', finish_reason: 'stop' }], captured),
        trajectory,
        prepare_step: () => undefined,
      }),
    )
    expect(captured[0]).toEqual([{ role: 'user', content: 'go' }])
    expect(events.some((e) => e.kind === 'step_prepared')).toBe(false)
  })

  it('is a no-op when the hook returns an object without messages', async () => {
    const captured: Array<ReadonlyArray<Message>> = []
    const { trajectory, events } = recording_trajectory()
    await run_tool_loop(
      base_config({
        invoke_once: capturing_invoke_once([{ text: 'hi', finish_reason: 'stop' }], captured),
        trajectory,
        prepare_step: () => ({}),
      }),
    )
    expect(captured[0]).toEqual([{ role: 'user', content: 'go' }])
    expect(events.some((e) => e.kind === 'step_prepared')).toBe(false)
  })

  it('records a step_prepared event with before/after counts, before request_sent, only on replaced turns', async () => {
    const captured: Array<ReadonlyArray<Message>> = []
    const { trajectory, events } = recording_trajectory()

    await run_tool_loop(
      base_config({
        invoke_once: capturing_invoke_once(
          [
            { tool_calls: [{ id: 'c1', name: 'echo', input: { value: 'hi' } }], finish_reason: 'tool_calls' },
            { text: 'done', finish_reason: 'stop' },
          ],
          captured,
        ),
        tools: [echo_tool()],
        trajectory,
        prepare_step: prune_first_turn,
      }),
    )

    const prepared = events.filter((e) => e.kind === 'step_prepared')
    expect(prepared).toHaveLength(1)
    expect(prepared[0]).toEqual({
      kind: 'step_prepared',
      step_index: 0,
      message_count_before: 1,
      message_count_after: 2,
    })

    // The event precedes the request it shaped.
    const kinds = events.map((e) => e.kind)
    const prepared_at = kinds.indexOf('step_prepared')
    const first_request_at = kinds.indexOf('request_sent')
    expect(prepared_at).toBeGreaterThanOrEqual(0)
    expect(prepared_at).toBeLessThan(first_request_at)
  })

  it('propagates a throwing hook (user code fails loud, not retried)', async () => {
    const captured: Array<ReadonlyArray<Message>> = []
    const boom = new Error('prune failed')
    await expect(
      run_tool_loop(
        base_config({
          invoke_once: capturing_invoke_once([{ text: 'never', finish_reason: 'stop' }], captured),
          prepare_step: () => {
            throw boom
          },
        }),
      ),
    ).rejects.toBe(boom)
    // The turn never fired.
    expect(captured).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Layer 2: loop-inheritance through the real engine + fake native adapter.
// ---------------------------------------------------------------------------

const PROVIDER = 'fake_native'
const MODEL = 'nat-1'

type ScriptedTurn = (req: TurnRequest) => TurnResult
type NativeLog = { requests: TurnRequest[] }

function make_fake_native_factory(
  log: NativeLog,
  turns: ReadonlyArray<ScriptedTurn>,
): ProviderFactory {
  return () => ({
    kind: 'native',
    name: PROVIDER,
    invoke_turn: async (req) => {
      log.requests.push(req)
      const turn = turns[log.requests.length - 1]
      if (turn === undefined) {
        throw new Error(`no scripted turn for invocation ${log.requests.length}`)
      }
      return turn(req)
    },
    supports: () => true,
  })
}

function make_engine(
  log: NativeLog,
  turns: ReadonlyArray<ScriptedTurn>,
  config?: Partial<EngineConfig>,
): ReturnType<typeof create_engine> {
  return create_engine({
    providers: { [PROVIDER]: {} },
    custom_providers: { [PROVIDER]: make_fake_native_factory(log, turns) },
    ...config,
  })
}

function text_turn(text: string): ScriptedTurn {
  return () => ({ text, tool_calls: [], finish_reason: 'stop', usage: { input_tokens: 4, output_tokens: 2 } })
}

function tool_call_turn(
  calls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
): ScriptedTurn {
  return () => ({ text: '', tool_calls: calls, finish_reason: 'tool_calls', usage: { input_tokens: 4, output_tokens: 2 } })
}

function make_echo_tool(overrides?: Partial<Tool>): Tool & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    name: 'echo',
    description: 'echo the value back',
    input_schema: z.object({ value: z.string() }),
    execute: (input: unknown) => {
      calls.push(input)
      return `echo:${(input as { value: string }).value}`
    },
    ...overrides,
    calls,
  }
}

/** A hook that prunes every turn to one fixed user message and records what it saw. */
function pruning_hook(saw: Array<{ step_index: number; messages: Message[] }>): PrepareStepHook {
  return (ctx) => {
    saw.push({ step_index: ctx.step_index, messages: [...ctx.messages] })
    return { messages: [{ role: 'user', content: 'pruned' }] }
  }
}

describe('prepare_step preserves loop behavior on the native transport', () => {
  it('keeps tool-call salvage intact: the salvaged call is executed and written to the real transcript', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool()
    const raw_text = '<tool_call>{"name":"echo","arguments":{"value":"ping"}}</tool_call>'
    const engine = make_engine(log, [text_turn(raw_text), text_turn('done')])
    const saw: Array<{ step_index: number; messages: Message[] }> = []

    const result = await engine.generate({
      model: MODEL,
      prompt: 'use the tool',
      tools: [echo],
      tool_call_repair_attempts: 1,
      prepare_step: pruning_hook(saw),
    })

    // Salvage still ran despite the request being pruned.
    expect(echo.calls).toEqual([{ value: 'ping' }])
    expect(result.content).toBe('done')
    expect(result.tool_calls[0]).toMatchObject({
      id: 'salvaged_0_0',
      name: 'echo',
      output: 'echo:ping',
      salvaged: true,
      salvaged_format: 'hermes',
    })

    // The adapter received the pruned request both turns, not the transcript.
    expect(log.requests[0]?.messages).toEqual([{ role: 'user', content: 'pruned' }])
    expect(log.requests[1]?.messages).toEqual([{ role: 'user', content: 'pruned' }])

    // The hook's view of turn 1 proves the canonical transcript carries the
    // salvaged structured call + fed tool result — pruning left it untouched.
    expect(saw[1]).toEqual({
      step_index: 1,
      messages: [
        { role: 'user', content: 'use the tool' },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'salvaged_0_0', name: 'echo', input: { value: 'ping' } }],
        },
        { role: 'tool', tool_call_id: 'salvaged_0_0', name: 'echo', content: 'echo:ping' },
      ],
    })
  })

  it('keeps fail-closed approval intact under pruning', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool({ needs_approval: true })
    const engine = make_engine(log, [
      tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'ping' } }]),
      text_turn('done'),
    ])
    const saw: Array<{ step_index: number; messages: Message[] }> = []
    const seen: Array<{ tool_name: string; input: unknown }> = []

    const result = await engine.generate({
      model: MODEL,
      prompt: 'go',
      tools: [echo],
      prepare_step: pruning_hook(saw),
      on_tool_approval: (req) => {
        seen.push({ tool_name: req.tool_name, input: req.input })
        return true
      },
    })

    expect(seen).toEqual([{ tool_name: 'echo', input: { value: 'ping' } }])
    expect(echo.calls).toEqual([{ value: 'ping' }])
    expect(result.tool_calls[0]).toMatchObject({ id: 'c1', output: 'echo:ping' })
    expect(saw.map((s) => s.step_index)).toEqual([0, 1])
  })

  it('keeps Tool.ends_turn intact: a terminal call still ends the loop under pruning', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool({ ends_turn: true })
    // Only one turn scripted: a second invocation would throw.
    const engine = make_engine(log, [
      tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'final' } }]),
    ])
    const saw: Array<{ step_index: number; messages: Message[] }> = []

    const result = await engine.generate({
      model: MODEL,
      prompt: 'go',
      tools: [echo],
      prepare_step: pruning_hook(saw),
    })

    expect(log.requests).toHaveLength(1)
    expect(echo.calls).toEqual([{ value: 'final' }])
    expect(result.finish_reason).toBe('stop')
    expect(saw).toHaveLength(1)
  })

  it('keeps schema-repair intact and runs on repair turns against the growing transcript', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, [text_turn('not json'), text_turn('{"n":7}')])
    const saw: Array<{ step_index: number; messages: Message[] }> = []

    const result = await engine.generate<{ n: number }>({
      model: MODEL,
      prompt: 'go',
      schema: z.object({ n: z.number() }),
      prepare_step: pruning_hook(saw),
    })

    expect(result.content).toEqual({ n: 7 })

    // The hook fired on both the initial turn and the repair re-invocation.
    expect(saw.map((s) => s.step_index)).toEqual([0, 1])
    // Turn 0: schema-prefix system message + the user prompt.
    expect(saw[0]?.messages).toEqual([
      {
        role: 'system',
        content: expect.stringContaining('single JSON value'),
      },
      { role: 'user', content: 'go' },
    ])
    // Turn 1: the transcript grew with the bad assistant reply + the appended
    // repair message — prepare_step spans the schema-repair re-invocation.
    expect(saw[1]?.messages).toHaveLength(4)
    expect(saw[1]?.messages[2]).toEqual({ role: 'assistant', content: 'not json' })
    expect(saw[1]?.messages[3]).toMatchObject({ role: 'user' })

    // The adapter saw the pruned request both turns.
    expect(log.requests[0]?.messages).toEqual([{ role: 'user', content: 'pruned' }])
    expect(log.requests[1]?.messages).toEqual([{ role: 'user', content: 'pruned' }])
  })
})
