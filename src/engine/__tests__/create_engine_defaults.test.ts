/**
 * Mutation-hardening for the construction defaults create_engine folds into its
 * per-instance EngineInternals (the `get_internals` derivation, spec §5.8).
 *
 * Each `defaults.*` knob is set at construction and then OBSERVED flowing through
 * a real engine.generate call: the request-visible ones (system, provider_options,
 * effort) against a captured TurnRequest, the loop knobs (tool_error_policy,
 * schema_repair_attempts, tool_call_repair_attempts, max_tool_calls_per_step,
 * max_steps) against their concrete loop behavior, and ai_sdk_telemetry against the
 * mocked generateText params. Dropping any default (the mutant that empties its
 * conditional spread) changes an assertion here. Dispose memoization and the
 * resource-guard are pinned the same way.
 *
 * `ai` and `@ai-sdk/otel` are mocked at the boundary so the ai_sdk telemetry path
 * runs without the real SDK; the native tests use in-memory fake adapters and
 * never touch either mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  build_mock_ai_module,
  enqueue_generate_text,
  make_text_result,
  mock_state,
  reset_mock_state,
} from './fixtures/mock_ai.js'

vi.mock('ai', async () => build_mock_ai_module())
vi.mock('@ai-sdk/otel', () => ({ OpenTelemetry: vi.fn() }))

import { create_engine } from '../create_engine.js'
import { provider_not_configured_error, tool_error } from '../errors.js'
import {
  default_normalize_usage,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderFactory,
} from '../providers/types.js'
import type { Tool, TurnRequest, TurnResult } from '../types.js'

const MODEL = 'nat-1'
const PROVIDER = 'fake_native'

type ScriptedTurn = (req: TurnRequest) => TurnResult

type NativeLog = { requests: TurnRequest[] }

function make_native_factory(
  log: NativeLog,
  turns: ReadonlyArray<ScriptedTurn>,
): ProviderFactory {
  return () => ({
    kind: 'native',
    name: PROVIDER,
    invoke_turn: async (req) => {
      const turn = turns[log.requests.length]
      log.requests.push(req)
      if (turn === undefined) throw new Error(`no scripted turn ${log.requests.length - 1}`)
      return turn(req)
    },
    supports: () => true,
  })
}

function text_turn(text: string): ScriptedTurn {
  return () => ({
    text,
    tool_calls: [],
    finish_reason: 'stop',
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

function tool_call_turn(
  calls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
): ScriptedTurn {
  return () => ({
    text: '',
    tool_calls: calls,
    finish_reason: 'tool_calls',
    usage: { input_tokens: 1, output_tokens: 1 },
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

const AI_SDK_CAPS: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
])

function make_ai_sdk_factory(): ProviderFactory {
  return () => ({
    kind: 'ai_sdk',
    name: 'fake_ai_sdk',
    build_model: async (model_id: string) => ({ _fake: true, model_id }),
    translate_effort: () => ({ provider_options: {}, effort_ignored: false }),
    normalize_usage: default_normalize_usage,
    supports: (capability) => AI_SDK_CAPS.has(capability),
  })
}

beforeEach(() => reset_mock_state())
afterEach(() => reset_mock_state())

describe('create_engine folds request-visible defaults into the turn', () => {
  it('applies defaults.system when the call omits system', async () => {
    const log: NativeLog = { requests: [] }
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: make_native_factory(log, [text_turn('ok')]) },
      defaults: { system: 'you are terse' },
    })

    await engine.generate({ model: MODEL, provider: PROVIDER, prompt: 'hi' })

    expect(log.requests[0]?.system).toBe('you are terse')
  })

  it('applies defaults.provider_options, merged onto the turn verbatim', async () => {
    const log: NativeLog = { requests: [] }
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: make_native_factory(log, [text_turn('ok')]) },
      defaults: { provider_options: { [PROVIDER]: { reasoning: 'deep' } } },
    })

    await engine.generate({ model: MODEL, provider: PROVIDER, prompt: 'hi' })

    expect(log.requests[0]?.provider_options).toEqual({ [PROVIDER]: { reasoning: 'deep' } })
  })

  it('applies defaults.effort as the resolved turn effort', async () => {
    const log: NativeLog = { requests: [] }
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: make_native_factory(log, [text_turn('ok')]) },
      defaults: { effort: 'high' },
    })

    await engine.generate({ model: MODEL, provider: PROVIDER, prompt: 'hi' })

    expect(log.requests[0]?.effort).toBe('high')
  })
})

describe('create_engine folds loop-knob defaults into generate', () => {
  it('caps the loop at defaults.max_steps', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool()
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: {
        [PROVIDER]: make_native_factory(log, [
          tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'one' } }]),
          text_turn('should never run'),
        ]),
      },
      defaults: { max_steps: 1 },
    })

    const result = await engine.generate({
      model: MODEL,
      provider: PROVIDER,
      prompt: 'go',
      tools: [echo],
    })

    // The single-step cap fires before a second model turn: exactly one request,
    // the tool is not executed, and the run resolves with 'max_steps'.
    expect(log.requests).toHaveLength(1)
    expect(echo.calls).toEqual([])
    expect(result.finish_reason).toBe('max_steps')
  })

  it('applies defaults.tool_error_policy: throw', async () => {
    const log: NativeLog = { requests: [] }
    const boom = make_echo_tool({
      execute: () => {
        throw new Error('kaboom')
      },
    })
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: {
        [PROVIDER]: make_native_factory(log, [
          tool_call_turn([{ id: 'c1', name: 'echo', input: { value: 'x' } }]),
          text_turn('would recover under feed_back'),
        ]),
      },
      defaults: { tool_error_policy: 'throw' },
    })

    // Under 'throw' the tool failure aborts the run on the first turn; the
    // feed_back fallback would instead swallow it and run the scripted second turn.
    await expect(
      engine.generate({ model: MODEL, provider: PROVIDER, prompt: 'go', tools: [boom] }),
    ).rejects.toBeInstanceOf(tool_error)
    expect(log.requests).toHaveLength(1)
  })

  it('applies defaults.schema_repair_attempts as the repair budget', async () => {
    const log: NativeLog = { requests: [] }
    const invalid = text_turn('not json at all')
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: make_native_factory(log, [invalid, invalid, invalid]) },
      defaults: { schema_repair_attempts: 2 },
    })

    // Budget 2 => initial turn + two repair turns = three requests before the
    // schema failure surfaces. The fallback budget of 1 would stop at two.
    await expect(
      engine.generate({
        model: MODEL,
        provider: PROVIDER,
        prompt: 'go',
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toThrow()
    expect(log.requests).toHaveLength(3)
  })

  it('applies defaults.tool_call_repair_attempts as the salvage budget', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool()
    const hermes = '<tool_call>{"name":"echo","arguments":{"value":"ping"}}</tool_call>'
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: {
        [PROVIDER]: make_native_factory(log, [text_turn(hermes), text_turn('done')]),
      },
      defaults: { tool_call_repair_attempts: 1 },
    })

    const result = await engine.generate({
      model: MODEL,
      provider: PROVIDER,
      prompt: 'go',
      tools: [echo],
    })

    // Budget 1 salvages the hermes-format text call; the fallback budget of 0
    // would leave the raw markup as the final content and never run echo.
    expect(echo.calls).toEqual([{ value: 'ping' }])
    expect(result.content).toBe('done')
  })

  it('applies defaults.max_tool_calls_per_step as the per-step clamp', async () => {
    const log: NativeLog = { requests: [] }
    const echo = make_echo_tool()
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: {
        [PROVIDER]: make_native_factory(log, [
          tool_call_turn([
            { id: 'c1', name: 'echo', input: { value: 'one' } },
            { id: 'c2', name: 'echo', input: { value: 'two' } },
          ]),
          text_turn('done'),
        ]),
      },
      defaults: { max_tool_calls_per_step: 1 },
    })

    const result = await engine.generate({
      model: MODEL,
      provider: PROVIDER,
      prompt: 'go',
      tools: [echo],
    })

    // Clamp 1 executes only the first call and marks the second dropped; without
    // the default both would execute and c2 would carry an output, not an error.
    expect(echo.calls).toEqual([{ value: 'one' }])
    expect(result.tool_calls[1]).toMatchObject({
      id: 'c2',
      error: { message: 'dropped_max_tool_calls_per_step' },
    })
  })

  it('applies defaults.ai_sdk_telemetry to the ai_sdk turn', async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { fake_ai_sdk: {} },
      custom_providers: { fake_ai_sdk: make_ai_sdk_factory() },
      defaults: { ai_sdk_telemetry: { enabled: true, function_id: 'summarize' } },
    })

    await engine.generate({ model: 'm', provider: 'fake_ai_sdk', prompt: 'hi' })

    const params = mock_state.last_generate_text_params as {
      experimental_telemetry?: { isEnabled?: boolean; functionId?: string }
    }
    // Dropping the default leaves experimental_telemetry unset (the disabled
    // gate returns undefined), so both the flag and the function id pin it.
    expect(params.experimental_telemetry?.isEnabled).toBe(true)
    expect(params.experimental_telemetry?.functionId).toBe('summarize')
  })
})

describe('engine.dispose', () => {
  it('memoizes: a second dispose does not re-tear-down the adapters', async () => {
    const log: NativeLog = { requests: [] }
    let disposals = 0
    const factory: ProviderFactory = () => ({
      kind: 'native',
      name: PROVIDER,
      invoke_turn: async () => text_turn('ok')({} as TurnRequest),
      supports: () => true,
      dispose: async () => {
        disposals += 1
      },
    })
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: factory },
    })

    await engine.dispose()
    await engine.dispose()

    expect(disposals).toBe(1)
    expect(log.requests).toEqual([])
  })

  it('skips an adapter whose dispose key is present but undefined', async () => {
    const factory: ProviderFactory = () =>
      ({
        kind: 'native',
        name: PROVIDER,
        invoke_turn: async () => text_turn('ok')({} as TurnRequest),
        supports: () => true,
        // A JS-authored custom provider can hand back an explicit `dispose:
        // undefined`; the resource-guard must treat that as "no disposer" rather
        // than invoking undefined.
        dispose: undefined,
      }) as unknown as ProviderAdapter
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: factory },
    })

    await expect(engine.dispose()).resolves.toBeUndefined()
  })
})

describe('create_engine skips a provider with an undefined init', () => {
  it('never invokes the factory for an undefined init, leaving the provider absent', async () => {
    let factory_calls = 0
    const factory: ProviderFactory = (init) => {
      factory_calls += 1
      if (init === undefined) throw new Error('factory must not run for an undefined init')
      return {
        kind: 'native',
        name: PROVIDER,
        invoke_turn: async () => text_turn('ok')({} as TurnRequest),
        supports: () => true,
      }
    }
    const engine = create_engine({
      providers: { [PROVIDER]: undefined },
      custom_providers: { [PROVIDER]: factory },
    })

    // The undefined init is skipped, so no adapter is built and the factory is
    // never called; reaching the provider at generate time is unconfigured.
    expect(factory_calls).toBe(0)
    await expect(
      engine.generate({ model: MODEL, provider: PROVIDER, prompt: 'hi' }),
    ).rejects.toBeInstanceOf(provider_not_configured_error)
  })
})
