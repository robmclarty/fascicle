/**
 * Mutation-hardening for the construction defaults create_engine folds into its
 * per-instance EngineInternals (the `get_internals` derivation).
 *
 * Each `defaults.*` knob is set at construction and then OBSERVED flowing through
 * a real engine.generate call: the request-visible ones (system, provider_options,
 * effort, temperature, max_tokens, top_p) against a captured TurnRequest, the loop
 * knobs (tool_error_policy,
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

import type { TrajectoryLogger } from '#core'
import { create_engine } from '../create_engine.js'
import { create_claude_cli_adapter } from '../providers/claude_cli/index.js'
import { engine_config_error, provider_not_configured_error, tool_error } from '../errors.js'
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

  it('applies defaults.temperature, max_tokens, and top_p when the call omits them', async () => {
    const log: NativeLog = { requests: [] }
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: make_native_factory(log, [text_turn('ok')]) },
      defaults: { temperature: 0.3, max_tokens: 512, top_p: 0.8 },
    })

    await engine.generate({ model: MODEL, provider: PROVIDER, prompt: 'hi' })

    expect(log.requests[0]?.temperature).toBe(0.3)
    expect(log.requests[0]?.max_tokens).toBe(512)
    expect(log.requests[0]?.top_p).toBe(0.8)
  })

  it('lets per-call sampling knobs win over the defaults', async () => {
    const log: NativeLog = { requests: [] }
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: make_native_factory(log, [text_turn('ok')]) },
      defaults: { temperature: 0.3, max_tokens: 512, top_p: 0.8 },
    })

    await engine.generate({
      model: MODEL,
      provider: PROVIDER,
      prompt: 'hi',
      temperature: 0.9,
      max_tokens: 64,
      top_p: 0.5,
    })

    expect(log.requests[0]?.temperature).toBe(0.9)
    expect(log.requests[0]?.max_tokens).toBe(64)
    expect(log.requests[0]?.top_p).toBe(0.5)
  })

  it('leaves the sampling knobs off the turn when neither default nor call sets them', async () => {
    const log: NativeLog = { requests: [] }
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: make_native_factory(log, [text_turn('ok')]) },
    })

    await engine.generate({ model: MODEL, provider: PROVIDER, prompt: 'hi' })

    // Absent everywhere means absent on the TurnRequest, not present-as-undefined
    // (the exactOptionalPropertyTypes contract native adapters rely on).
    expect(log.requests).toHaveLength(1)
    const req = log.requests[0] as unknown as Record<string, unknown>
    expect('temperature' in req).toBe(false)
    expect('max_tokens' in req).toBe(false)
    expect('top_p' in req).toBe(false)
  })
})

describe('create_engine folds the cache default into generate', () => {
  /** A native factory that declares opt-in caching, so only a setting turns it on. */
  function opt_in_factory(log: NativeLog): ProviderFactory {
    const base = make_native_factory(log, [text_turn('ok')])
    return (init) => ({ ...base(init), prompt_cache: 'opt_in' }) as ProviderAdapter
  }

  it('applies defaults.cache when the call sets none', async () => {
    const log: NativeLog = { requests: [] }
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: opt_in_factory(log) },
      defaults: { cache: '1h' },
    })

    await engine.generate({ model: MODEL, provider: PROVIDER, prompt: 'hi' })

    expect(log.requests[0]?.cache).toBe('1h')
  })

  it("lets a call's cache win over defaults.cache", async () => {
    const log: NativeLog = { requests: [] }
    const engine = create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: opt_in_factory(log) },
      defaults: { cache: '1h' },
    })

    await engine.generate({ model: MODEL, provider: PROVIDER, prompt: 'hi', cache: 'off' })

    expect('cache' in (log.requests[0] ?? {})).toBe(false)
  })

  it('throws engine_config_error at construction for an unknown defaults.cache', () => {
    const build = (): unknown =>
      create_engine({
        providers: { [PROVIDER]: {} },
        custom_providers: { [PROVIDER]: opt_in_factory({ requests: [] }) },
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        defaults: { cache: '10m' as unknown as '5m' },
      })
    expect(build).toThrow(engine_config_error)
    expect(build).toThrow(`defaults.cache must be one of 'off', '5m', '1h', got "10m"`)
  })
})

describe('create_engine folds the capture default into generate', () => {
  /** Record every event, and read back what each request_sent carried. */
  function recorder(): { trajectory: TrajectoryLogger; requests: () => unknown[] } {
    const events: Array<Record<string, unknown>> = []
    return {
      trajectory: { record: (e) => events.push(e), start_span: (name) => name, end_span: () => {} },
      requests: () => events.filter((e) => e['kind'] === 'request_sent').map((e) => e['request']),
    }
  }

  function native_engine(log: NativeLog, capture?: 'off' | 'turns'): ReturnType<typeof create_engine> {
    return create_engine({
      providers: { [PROVIDER]: {} },
      custom_providers: { [PROVIDER]: make_native_factory(log, [text_turn('ok')]) },
      ...(capture === undefined ? {} : { defaults: { capture } }),
    })
  }

  it('applies defaults.capture when the call sets none', async () => {
    const { trajectory, requests } = recorder()
    await native_engine({ requests: [] }, 'turns').generate({ model: MODEL, provider: PROVIDER, prompt: 'hi', trajectory })
    expect(requests()).toStrictEqual([
      {
        settings: { provider: PROVIDER, model_id: MODEL, effort: 'none' },
        tools: [],
        messages: [{ role: 'user', content: 'hi' }],
      },
    ])
  })

  it("lets a call's capture win over defaults.capture", async () => {
    const { trajectory, requests } = recorder()
    await native_engine({ requests: [] }, 'off').generate({
      model: MODEL,
      provider: PROVIDER,
      prompt: 'hi',
      capture: 'turns',
      trajectory,
    })
    const quiet = recorder()
    await native_engine({ requests: [] }, 'turns').generate({
      model: MODEL,
      provider: PROVIDER,
      prompt: 'hi',
      capture: 'off',
      trajectory: quiet.trajectory,
    })
    expect(requests()).toHaveLength(1)
    expect(requests()[0]).toBeDefined()
    expect(quiet.requests()).toStrictEqual([undefined])
  })

  it('throws engine_config_error at construction for an unknown defaults.capture', () => {
    const build = (): unknown =>
      create_engine({
        providers: { [PROVIDER]: {} },
        custom_providers: { [PROVIDER]: make_native_factory({ requests: [] }, []) },
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        defaults: { capture: 'all' as unknown as 'turns' },
      })
    expect(build).toThrow(engine_config_error)
    expect(build).toThrow(`defaults.capture must be one of 'off', 'turns', 'wire', got "all"`)
  })

  it('throws engine_config_error at generate for an unknown capture, before any request', async () => {
    const log: NativeLog = { requests: [] }
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const call = native_engine(log).generate({ model: MODEL, provider: PROVIDER, prompt: 'hi', capture: 'full' as unknown as 'turns' })
    await expect(call).rejects.toBeInstanceOf(engine_config_error)
    await expect(call).rejects.toThrow(`capture must be one of 'off', 'turns', 'wire', got "full"`)
    expect(log.requests).toStrictEqual([])
  })

  it('throws engine_config_error at construction for an unknown defaults.truncated_turn_policy', () => {
    const build = (): unknown =>
      create_engine({
        providers: { [PROVIDER]: {} },
        custom_providers: { [PROVIDER]: make_native_factory({ requests: [] }, []) },
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        defaults: { truncated_turn_policy: 'retry' as unknown as 'continue' },
      })
    expect(build).toThrow(engine_config_error)
    expect(build).toThrow(`defaults.truncated_turn_policy must be one of 'stop', 'continue', got "retry"`)
  })

  it('throws engine_config_error at generate for an unknown truncated_turn_policy, before any request', async () => {
    const log: NativeLog = { requests: [] }
    const call = native_engine(log).generate({
      model: MODEL,
      provider: PROVIDER,
      prompt: 'hi',
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      truncated_turn_policy: 'resume' as unknown as 'continue',
    })
    await expect(call).rejects.toBeInstanceOf(engine_config_error)
    await expect(call).rejects.toThrow(`truncated_turn_policy must be one of 'stop', 'continue', got "resume"`)
    expect(log.requests).toStrictEqual([])
  })

  it('throws engine_config_error for an unknown capture on claude_cli before any subprocess starts', async () => {
    // A spawn of this binary would fail as claude_cli_error, so the config
    // error proves the check ran ahead of the external adapter.
    const engine = create_engine({
      providers: { cli: { binary: '/nonexistent/fascicle-test/claude' } },
      custom_providers: { cli: create_claude_cli_adapter },
    })
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const call = engine.generate({ model: 'sonnet', prompt: 'go', capture: 'on' as unknown as 'turns' })
    await expect(call).rejects.toBeInstanceOf(engine_config_error)
    await expect(call).rejects.toThrow(`capture must be one of 'off', 'turns', 'wire', got "on"`)
  })

  it("captures the caller's provider_options on ai_sdk, without the keys effort and cache derive", async () => {
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { fake_ai_sdk: {} },
      custom_providers: {
        fake_ai_sdk: (init) => ({
          ...(make_ai_sdk_factory()(init) as Extract<ProviderAdapter, { kind: 'ai_sdk' }>),
          prompt_cache: 'opt_in',
          translate_effort: () => ({ provider_options: { fake_ai_sdk: { thinking: 'deep' } }, effort_ignored: false }),
          translate_cache: () => ({ fake_ai_sdk: { cacheControl: { type: 'ephemeral' } } }),
        }),
      },
      defaults: { provider_options: { fake_ai_sdk: { from_defaults: 1 } } },
    })
    const { trajectory, requests } = recorder()

    await engine.generate({
      model: 'm',
      provider: 'fake_ai_sdk',
      prompt: 'hi',
      effort: 'high',
      cache: '5m',
      provider_options: { fake_ai_sdk: { from_call: 2 } },
      capture: 'turns',
      trajectory,
    })

    const sent = mock_state.last_generate_text_params as { providerOptions?: Record<string, unknown> }
    expect(sent.providerOptions).toStrictEqual({
      fake_ai_sdk: { thinking: 'deep', cacheControl: { type: 'ephemeral' }, from_defaults: 1, from_call: 2 },
    })
    expect(requests()[0]).toMatchObject({
      settings: {
        provider: 'fake_ai_sdk',
        model_id: 'm',
        effort: 'high',
        cache: '5m',
        provider_options: { fake_ai_sdk: { from_defaults: 1, from_call: 2 } },
      },
    })
    const settings = (requests()[0] as { settings: { provider_options: Record<string, Record<string, unknown>> } }).settings
    expect(settings.provider_options).toStrictEqual({ fake_ai_sdk: { from_defaults: 1, from_call: 2 } })
  })
})

describe("capture: 'wire' on the ai_sdk transport", () => {
  it("records option_ignored once and captures as 'turns'", async () => {
    enqueue_generate_text(make_text_result('ok'))
    enqueue_generate_text(make_text_result('ok'))
    const engine = create_engine({
      providers: { fake_ai_sdk: {} },
      custom_providers: { fake_ai_sdk: make_ai_sdk_factory() },
      defaults: { capture: 'wire' },
    })
    const events: Array<Record<string, unknown>> = []
    const trajectory: TrajectoryLogger = {
      record: (e) => {
        const { ts: _ts, ...rest } = e
        events.push(rest)
      },
      start_span: (name) => name,
      end_span: () => {},
    }
    await engine.generate({ model: 'm', provider: 'fake_ai_sdk', prompt: 'hi', trajectory })
    expect(events.filter((e) => e['kind'] === 'option_ignored')).toStrictEqual([
      { kind: 'option_ignored', option: 'capture', provider: 'fake_ai_sdk', reason: 'wire capture needs a native transport' },
    ])
    expect(events.find((e) => e['kind'] === 'request_sent')).toHaveProperty('request')
    expect(events.filter((e) => e['kind'] === 'request_wire')).toStrictEqual([])

    const quiet: Array<Record<string, unknown>> = []
    await engine.generate({
      model: 'm',
      provider: 'fake_ai_sdk',
      prompt: 'hi',
      capture: 'turns',
      trajectory: { record: (e) => quiet.push(e), start_span: (name) => name, end_span: () => {} },
    })
    expect(quiet.filter((e) => e['kind'] === 'option_ignored')).toStrictEqual([])
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

  it('applies defaults.truncated_turn_policy, and a call that sets its own wins', async () => {
    const cut_off: ScriptedTurn = () => ({
      text: '',
      tool_calls: [],
      finish_reason: 'length',
      usage: { input_tokens: 1, output_tokens: 40 },
    })
    const run = async (per_call: 'stop' | undefined): Promise<{ log: NativeLog; finish: string }> => {
      const log: NativeLog = { requests: [] }
      const engine = create_engine({
        providers: { [PROVIDER]: {} },
        custom_providers: { [PROVIDER]: make_native_factory(log, [cut_off, text_turn('done')]) },
        defaults: { truncated_turn_policy: 'continue', max_tokens: 40 },
      })
      const result = await engine.generate({
        model: MODEL,
        provider: PROVIDER,
        prompt: 'go',
        tools: [make_echo_tool()],
        ...(per_call === undefined ? {} : { truncated_turn_policy: per_call }),
      })
      return { log, finish: result.finish_reason }
    }

    // The default goes on past the cut-off turn, naming defaults.max_tokens;
    // the call's own 'stop' ends the loop there, as it would with no default.
    const continued = await run(undefined)
    expect(continued.finish).toBe('stop')
    expect(continued.log.requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content:
        'Your last turn reached the 40-token output limit before it finished, so it was cut off. ' +
        'Keep this turn short: make your next tool call, or give your final answer.',
    })
    const stopped = await run('stop')
    expect(stopped.finish).toBe('length')
    expect(stopped.log.requests).toHaveLength(1)
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
