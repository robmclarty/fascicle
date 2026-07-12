/**
 * Loop-inheritance proof for the native transport (spec S-P2.7).
 *
 * An in-memory fake native adapter (kind: 'native', no HTTP) is registered
 * through custom_providers and driven through the real engine.generate path:
 * create_engine -> generate -> build_native_invoke -> retry_turn ->
 * run_tool_loop. Each test pins one loop feature the adapter must inherit
 * without implementing anything itself: salvage, fail-closed approval,
 * Tool.ends_turn, per-step clamping, cost, trajectory events, and
 * retry-on-classified-error. Assertions are concrete values (exact records,
 * exact cost math, exact event payloads), not smoke.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import { create_engine } from '../create_engine.js'
import {
  provider_error,
  rate_limit_error,
  tool_approval_denied_error,
} from '../errors.js'
import type { ProviderFactory } from '../providers/types.js'
import type {
  EngineConfig,
  RetryPolicy,
  Tool,
  TurnRequest,
  TurnResult,
} from '../types.js'

const PROVIDER = 'fake_native'
const MODEL = 'nat-1'

/** No backoff waits so retry tests run instantly. */
const INSTANT_RETRY: RetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 0,
  max_delay_ms: 0,
  retry_on: ['rate_limit', 'provider_5xx', 'network'],
}

type ScriptedTurn = (req: TurnRequest) => TurnResult

type NativeLog = {
  requests: TurnRequest[]
}

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

function text_turn(text: string, input_tokens = 4, output_tokens = 2): ScriptedTurn {
  return () => ({
    text,
    tool_calls: [],
    finish_reason: 'stop',
    usage: { input_tokens, output_tokens },
  })
}

function tool_call_turn(
  calls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
  input_tokens = 4,
  output_tokens = 2,
): ScriptedTurn {
  return () => ({
    text: '',
    tool_calls: calls,
    finish_reason: 'tool_calls',
    usage: { input_tokens, output_tokens },
  })
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

function create_recorder(): {
  trajectory: TrajectoryLogger
  records: TrajectoryEvent[]
  spans: Array<{ op: 'start' | 'end'; id: string; name?: string }>
} {
  const records: TrajectoryEvent[] = []
  const spans: Array<{ op: 'start' | 'end'; id: string; name?: string }> = []
  let counter = 0
  const trajectory: TrajectoryLogger = {
    record(event: TrajectoryEvent) {
      records.push(event)
    },
    start_span(name) {
      counter += 1
      const id = `span-${counter}`
      spans.push({ op: 'start', id, name })
      return id
    },
    end_span(id) {
      spans.push({ op: 'end', id })
    },
  }
  return { trajectory, records, spans }
}

describe('native adapter inherits tool-call salvage', () => {
  it('salvages a hermes-format text call, executes it, and marks provenance', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool()
    const raw_text = '<tool_call>{"name":"echo","arguments":{"value":"ping"}}</tool_call>'
    const engine = make_engine(log, [text_turn(raw_text), text_turn('done')])
    const { trajectory, records } = create_recorder()

    const result = await engine.generate({
      model: MODEL,
      prompt: 'use the tool',
      tools: [echo],
      tool_call_repair_attempts: 1,
      trajectory,
    })

    expect(echo.calls).toEqual([{ value: 'ping' }])
    expect(result.content).toBe('done')
    expect(result.tool_calls).toHaveLength(1)
    expect(result.tool_calls[0]).toMatchObject({
      id: 'salvaged_0_0',
      name: 'echo',
      input: { value: 'ping' },
      output: 'echo:ping',
      salvaged: true,
      salvaged_format: 'hermes',
    })
    // The step keeps the raw text for debugging and reports 'tool_calls' so
    // downstream consumers see the same shape a structured tool turn produces.
    expect(result.steps[0]?.text).toBe(raw_text)
    expect(result.steps[0]?.finish_reason).toBe('tool_calls')

    const salvaged_event = records.find((e) => e.kind === 'tool_call_salvaged')
    expect(salvaged_event).toMatchObject({
      step_index: 0,
      calls: [{ tool_call_id: 'salvaged_0_0', name: 'echo', format: 'hermes' }],
      raw_text,
    })

    // History carries the structured call (not the raw markup) and the fed
    // tool result, so the second turn's request looks like a native tool turn.
    expect(log.requests[1]?.messages).toEqual([
      { role: 'user', content: 'use the tool' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'salvaged_0_0', name: 'echo', input: { value: 'ping' } },
        ],
      },
      { role: 'tool', tool_call_id: 'salvaged_0_0', name: 'echo', content: 'echo:ping' },
    ])
  })

  it('leaves salvageable text alone when the budget is 0 (default)', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool()
    const raw_text = '<tool_call>{"name":"echo","arguments":{"value":"ping"}}</tool_call>'
    const engine = make_engine(log, [text_turn(raw_text)])

    const result = await engine.generate({
      model: MODEL,
      prompt: 'use the tool',
      tools: [echo],
    })

    expect(echo.calls).toEqual([])
    expect(result.content).toBe(raw_text)
    expect(result.tool_calls).toEqual([])
    expect(log.requests).toHaveLength(1)
  })
})

describe('native adapter inherits fail-closed approval', () => {
  it('throws tool_approval_denied_error when needs_approval is set and no handler exists', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool({ needs_approval: true })
    const engine = make_engine(log, [
      tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'ping' } }]),
    ])
    const { trajectory, records } = create_recorder()

    await expect(
      engine.generate({ model: MODEL, prompt: 'go', tools: [echo], trajectory }),
    ).rejects.toThrow(tool_approval_denied_error)

    expect(echo.calls).toEqual([])
    expect(log.requests).toHaveLength(1)
    expect(records.filter((e) => e.kind === 'tool_approval_requested')).toHaveLength(1)
    expect(records.filter((e) => e.kind === 'tool_approval_denied')).toHaveLength(1)
  })

  it('feeds a handler denial back as a tool error without executing', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool({ needs_approval: true })
    const engine = make_engine(log, [
      tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'ping' } }]),
      text_turn('gave up'),
    ])

    const result = await engine.generate({
      model: MODEL,
      prompt: 'go',
      tools: [echo],
      on_tool_approval: () => false,
    })

    expect(echo.calls).toEqual([])
    expect(result.content).toBe('gave up')
    expect(result.tool_calls[0]).toMatchObject({
      id: 'c1',
      name: 'echo',
      error: { message: 'tool_approval_denied' },
    })
    expect(log.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      name: 'echo',
      content: '{"error":"tool_approval_denied"}',
    })
  })

  it('executes when the handler grants, passing the validated request', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool({ needs_approval: true })
    const approval_requests: Array<{ tool_name: string; input: unknown; step_index: number }> = []
    const engine = make_engine(log, [
      tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'ping' } }]),
      text_turn('done'),
    ])
    const { trajectory, records } = create_recorder()

    const result = await engine.generate({
      model: MODEL,
      prompt: 'go',
      tools: [echo],
      trajectory,
      on_tool_approval: (req) => {
        approval_requests.push({
          tool_name: req.tool_name,
          input: req.input,
          step_index: req.step_index,
        })
        return true
      },
    })

    expect(approval_requests).toEqual([
      { tool_name: 'echo', input: { value: 'ping' }, step_index: 0 },
    ])
    expect(echo.calls).toEqual([{ value: 'ping' }])
    expect(result.tool_calls[0]).toMatchObject({ id: 'c1', output: 'echo:ping' })
    expect(records.filter((e) => e.kind === 'tool_approval_granted')).toHaveLength(1)
  })
})

describe('native adapter inherits Tool.ends_turn', () => {
  it('ends the loop after a successful terminal call without another turn', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool({ ends_turn: true })
    // Only one turn scripted: a second invocation would throw.
    const engine = make_engine(log, [
      tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'final' } }]),
    ])

    const result = await engine.generate({ model: MODEL, prompt: 'go', tools: [echo] })

    expect(log.requests).toHaveLength(1)
    expect(echo.calls).toEqual([{ value: 'final' }])
    expect(result.finish_reason).toBe('stop')
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.finish_reason).toBe('tool_calls')
    expect(result.tool_calls[0]).toMatchObject({
      id: 'c1',
      name: 'echo',
      output: 'echo:final',
    })
  })

  it('does not end the loop when the terminal call is denied', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool({ ends_turn: true, needs_approval: true })
    const engine = make_engine(log, [
      tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'final' } }]),
      text_turn('kept going'),
    ])

    const result = await engine.generate({
      model: MODEL,
      prompt: 'go',
      tools: [echo],
      on_tool_approval: () => false,
    })

    expect(log.requests).toHaveLength(2)
    expect(echo.calls).toEqual([])
    expect(result.content).toBe('kept going')
  })
})

describe('native adapter inherits per-step clamping', () => {
  it('drops calls beyond max_tool_calls_per_step and excludes them from history', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool()
    const engine = make_engine(log, [
      tool_call_turn([
        { id: 'c1', name: 'echo', input: { value: 'one' } },
        { id: 'c2', name: 'echo', input: { value: 'two' } },
      ]),
      text_turn('done'),
    ])
    const { trajectory, records } = create_recorder()

    const result = await engine.generate({
      model: MODEL,
      prompt: 'go',
      tools: [echo],
      max_tool_calls_per_step: 1,
      trajectory,
    })

    expect(echo.calls).toEqual([{ value: 'one' }])
    expect(result.tool_calls).toHaveLength(2)
    expect(result.tool_calls[0]).toMatchObject({ id: 'c1', output: 'echo:one' })
    expect(result.tool_calls[1]).toMatchObject({
      id: 'c2',
      name: 'echo',
      error: { message: 'dropped_max_tool_calls_per_step' },
    })

    const dropped_event = records.find((e) => e.kind === 'tool_calls_dropped')
    expect(dropped_event).toMatchObject({
      step_index: 0,
      max_tool_calls_per_step: 1,
      kept: 1,
      dropped: [{ tool_call_id: 'c2', name: 'echo' }],
    })

    // The dropped call never reaches history: the assistant message carries
    // only c1 and only one tool result is fed back.
    expect(log.requests[1]?.messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'echo', input: { value: 'one' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'echo', content: 'echo:one' },
    ])
  })
})

describe('native adapter inherits cost', () => {
  it('computes per-step and aggregated cost from the engine pricing table', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool()
    const engine = make_engine(
      log,
      [
        tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'ping' } }], 1000, 500),
        () => ({
          text: 'done',
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 2000, output_tokens: 1000 },
        }),
      ],
      { pricing: { [`${PROVIDER}:${MODEL}`]: { input_per_million: 10, output_per_million: 20 } } },
    )
    const { trajectory, records } = create_recorder()

    const result = await engine.generate({
      model: MODEL,
      prompt: 'go',
      tools: [echo],
      trajectory,
    })

    expect(result.steps[0]?.cost).toEqual({
      total_usd: 0.02,
      input_usd: 0.01,
      output_usd: 0.01,
      currency: 'USD',
      is_estimate: true,
    })
    expect(result.steps[1]?.cost).toEqual({
      total_usd: 0.04,
      input_usd: 0.02,
      output_usd: 0.02,
      currency: 'USD',
      is_estimate: true,
    })
    expect(result.cost).toEqual({
      total_usd: 0.06,
      input_usd: 0.03,
      output_usd: 0.03,
      currency: 'USD',
      is_estimate: true,
    })
    expect(result.usage).toEqual({ input_tokens: 3000, output_tokens: 1500 })

    const cost_events = records.filter((e) => e.kind === 'cost')
    expect(cost_events).toHaveLength(2)
    expect(cost_events[0]).toMatchObject({
      step_index: 0,
      source: 'engine_derived',
      total_usd: 0.02,
      input_usd: 0.01,
      output_usd: 0.01,
    })
  })

  it('emits pricing_missing once for an unpriced paid provider', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool()
    const engine = make_engine(log, [
      tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'ping' } }]),
      text_turn('done'),
    ])
    const { trajectory, records } = create_recorder()

    const result = await engine.generate({ model: MODEL, prompt: 'go', tools: [echo], trajectory })

    expect(result.cost).toBeUndefined()
    const missing = records.filter((e) => e.kind === 'pricing_missing')
    // Deduped: one event despite two steps hitting the unpriced model.
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({
      kind: 'pricing_missing',
      provider: PROVIDER,
      model_id: MODEL,
    })
  })
})

describe('native adapter inherits trajectory events', () => {
  it('records the full request/tool/step sequence for a tool-loop run', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool()
    const engine = make_engine(log, [
      tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'ping' } }], 4, 2),
      text_turn('done', 8, 3),
    ])
    const { trajectory, records, spans } = create_recorder()

    await engine.generate({ model: MODEL, prompt: 'go', tools: [echo], trajectory })

    expect(records.map((e) => e.kind)).toEqual([
      'request_sent',
      'response_received',
      'tool_call',
      'tool_result',
      // No pricing configured for the fake provider; emitted once, after the
      // first step's cost resolution.
      'pricing_missing',
      'request_sent',
      'response_received',
    ])
    expect(records[1]).toMatchObject({
      kind: 'response_received',
      step_index: 0,
      output_tokens: 2,
      finish_reason: 'tool_calls',
    })
    expect(records[2]).toMatchObject({
      kind: 'tool_call',
      step_index: 0,
      name: 'echo',
      tool_call_id: 'c1',
      input: { value: 'ping' },
    })
    expect(records[3]).toMatchObject({
      kind: 'tool_result',
      step_index: 0,
      tool_call_id: 'c1',
      output: 'echo:ping',
    })
    expect(records[6]).toMatchObject({
      kind: 'response_received',
      step_index: 1,
      output_tokens: 3,
      finish_reason: 'stop',
    })

    // One generate span wrapping one step span per turn, all closed.
    expect(spans.map((s) => `${s.op}:${s.name ?? s.id}`)).toEqual([
      'start:engine.generate',
      'start:engine.generate.step',
      'end:span-2',
      'start:engine.generate.step',
      'end:span-3',
      'end:span-1',
    ])
  })
})

const always_429: ScriptedTurn = () => {
  throw Object.assign(new Error('slow down'), {
    statusCode: 429,
    responseHeaders: { 'retry-after': '0' },
  })
}

const always_503: ScriptedTurn = () => {
  throw Object.assign(new Error('upstream exploded'), { statusCode: 503 })
}

describe('native adapter inherits retry-on-classified-error', () => {
  it('retries a 5xx classified by the shared classifier and succeeds', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, [
      () => {
        throw Object.assign(new Error('upstream exploded'), { statusCode: 503 })
      },
      text_turn('recovered'),
    ])

    const result = await engine.generate({
      model: MODEL,
      prompt: 'go',
      retry: INSTANT_RETRY,
    })

    expect(log.requests).toHaveLength(2)
    expect(result.content).toBe('recovered')
    expect(result.steps).toHaveLength(1)
  })

  it('honors an adapter classify_error override for bespoke error shapes', async () => {
    const log: NativeLog = { requests: [] }
    let classified: unknown
    const factory: ProviderFactory = () => ({
      kind: 'native',
      name: PROVIDER,
      invoke_turn: async (req) => {
        log.requests.push(req)
        if (log.requests.length === 1) throw new Error('QUOTA_BUCKET_DRAINED')
        return {
          text: 'recovered',
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
      supports: () => true,
      classify_error: (err) => {
        classified = err
        if (err instanceof Error && err.message === 'QUOTA_BUCKET_DRAINED') {
          return { kind: 'rate_limit', status: 429, message: err.message }
        }
        return err
      },
    })
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: factory },
    })

    const result = await engine.generate({
      model: MODEL,
      prompt: 'go',
      retry: INSTANT_RETRY,
    })

    expect(log.requests).toHaveLength(2)
    expect(result.content).toBe('recovered')
    expect(classified).toBeInstanceOf(Error)
  })

  it('surfaces rate_limit_error after exhausting attempts', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, [always_429, always_429])

    await expect(
      engine.generate({
        model: MODEL,
        prompt: 'go',
        retry: { ...INSTANT_RETRY, max_attempts: 2 },
      }),
    ).rejects.toThrow(rate_limit_error)

    expect(log.requests).toHaveLength(2)
  })

  it('surfaces provider_error with cause_kind after 5xx exhaustion', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, [always_503, always_503])

    let thrown: unknown
    try {
      await engine.generate({
        model: MODEL,
        prompt: 'go',
        retry: { ...INSTANT_RETRY, max_attempts: 2 },
      })
    } catch (err: unknown) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(provider_error)
    expect((thrown as provider_error).cause_kind).toBe('provider_5xx')
    expect(log.requests).toHaveLength(2)
  })

  it('does not retry an unclassified error', async () => {
    const log: NativeLog = { requests: [] }
    const bad_request = Object.assign(new Error('bad request'), { statusCode: 400 })
    const engine = make_engine(log, [
      () => {
        throw bad_request
      },
      text_turn('never reached'),
    ])

    await expect(
      engine.generate({ model: MODEL, prompt: 'go', retry: INSTANT_RETRY }),
    ).rejects.toBe(bad_request)

    expect(log.requests).toHaveLength(1)
  })
})

describe('native adapter inherits generate-option forwarding', () => {
  it('threads every present sampling/schema/provider option onto the TurnRequest', async () => {
    const log: NativeLog = { requests: [] }
    const schema = z.object({ answer: z.string() })
    // Return schema-valid JSON so the parse succeeds and the loop settles in one
    // turn; the request we assert on is still the first (and only) invocation.
    const engine = make_engine(log, [text_turn('{"answer":"yes"}')])

    await engine.generate({
      model: MODEL,
      prompt: 'hi',
      temperature: 0.7,
      max_tokens: 128,
      top_p: 0.9,
      schema,
      provider_options: { [PROVIDER]: { foo: 'bar' } },
    })

    const req = log.requests[0]
    // Each optional key is forwarded with its exact value; an inverted guard or
    // dropped object-literal would omit it (undefined) from the request.
    expect(req?.temperature).toBe(0.7)
    expect(req?.max_tokens).toBe(128)
    expect(req?.top_p).toBe(0.9)
    expect(req?.schema).toBe(schema)
    expect(req?.provider_options).toEqual({ [PROVIDER]: { foo: 'bar' } })
  })

  it('omits every absent option key from the TurnRequest', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, [text_turn('ok')])

    await engine.generate({ model: MODEL, prompt: 'hi' })

    const req = log.requests[0]
    // The spread-only-when-defined guards must not add undefined-valued keys;
    // a forced-true guard would surface each as `key: undefined`.
    expect(req).toBeDefined()
    expect('temperature' in (req as object)).toBe(false)
    expect('max_tokens' in (req as object)).toBe(false)
    expect('top_p' in (req as object)).toBe(false)
    expect('schema' in (req as object)).toBe(false)
    expect('provider_options' in (req as object)).toBe(false)
    expect('system' in (req as object)).toBe(false)
  })

  it('hoists a leading system message onto TurnRequest.system', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, [text_turn('ok')])

    await engine.generate({ model: MODEL, system: 'be brief', prompt: 'hi' })

    const req = log.requests[0]
    expect(req?.system).toBe('be brief')
    // The hoisted system run is stripped from the conversation messages.
    expect(req?.messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})
