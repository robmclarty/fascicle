import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  aborted_error,
  engine_disposed_error,
} from '../../../errors.js'
import type { GenerateOptions, Message, ResolvedModel, StreamChunk, Tool } from '../../../types.js'
import { create_claude_cli_adapter } from '../../../providers/claude_cli/adapter.js'
import { create_captured_trajectory, success_ops } from './fixtures/mock_helpers.js'

// Drive generate() against a fake spawn runtime instead of a real subprocess, so
// the full orchestration (argv assembly, option_ignored, tool bridge, schema
// repair, span lifecycle, error classification) is deterministic. The real
// subprocess path stays covered by integration.test.ts and friends.
type Close = { code: number; signal: NodeJS.Signals | null; stderr: string }
const { hooks } = vi.hoisted(() => ({
  hooks: {
    spawn_calls: [] as Array<Record<string, unknown>>,
    responses: [] as Array<{ lines: string[]; close: Close }>,
    dispose_calls: 0,
  },
}))

vi.mock('../../../providers/claude_cli/spawn.js', () => ({
  create_spawn_runtime: () => ({
    spawn_cli: async (args: Record<string, unknown>) => {
      const idx = hooks.spawn_calls.length
      hooks.spawn_calls.push(args)
      const resp = hooks.responses[idx] ??
        hooks.responses[hooks.responses.length - 1] ?? {
          lines: [],
          close: { code: 0, signal: null, stderr: '' },
        }
      return {
        stdout_lines: (async function* () {
          for (const line of resp.lines) yield line
        })(),
        wait_close: async (): Promise<Close> => resp.close,
      }
    },
    dispose_all: async (): Promise<void> => {
      hooks.dispose_calls += 1
    },
  }),
}))

const ZERO_CLOSE: Close = { code: 0, signal: null, stderr: '' }
const RESOLVED: ResolvedModel = { provider: 'claude_cli', model_id: 'claude-sonnet-4-5' }

const success_lines = (text: string, opts: Parameters<typeof success_ops>[1] = {}): string[] =>
  success_ops(text, opts).map((o) => JSON.stringify((o as { data: unknown }).data))

function gen<T = string>(partial: Partial<GenerateOptions<T>>): GenerateOptions<T> {
  return { prompt: 'hi', ...partial } as GenerateOptions<T>
}

const exec_tool = (name: string): Tool => ({
  name,
  description: 'd',
  input_schema: z.object({}),
  execute: () => null,
})
// A tool with no `execute` closure (allowed-only); the bridge must treat it
// differently from an executable one.
const plain_tool = (name: string): Tool =>
  ({ name, description: 'd', input_schema: z.object({}) }) as unknown as Tool

beforeEach(() => {
  hooks.spawn_calls = []
  hooks.responses = []
  hooks.dispose_calls = 0
})

describe('claude_cli adapter generate', () => {
  it('throws engine_disposed_error after dispose', async () => {
    const adapter = create_claude_cli_adapter({})
    await adapter.dispose()
    await expect(adapter.generate(gen({}), RESOLVED)).rejects.toBeInstanceOf(engine_disposed_error)
    expect(hooks.dispose_calls).toBe(1)
  })

  it('throws aborted_error without spawning when the signal is already aborted', async () => {
    const adapter = create_claude_cli_adapter({})
    const controller = new AbortController()
    controller.abort('stop')
    await expect(adapter.generate(gen({ abort: controller.signal }), RESOLVED)).rejects.toBeInstanceOf(
      aborted_error,
    )
    expect(hooks.spawn_calls).toHaveLength(0)
  })

  it('spawns with the prompt as stdin and the resolved model in argv, returning the result', async () => {
    hooks.responses = [{ lines: success_lines('hello back'), close: ZERO_CLOSE }]
    const adapter = create_claude_cli_adapter({})
    const result = await adapter.generate(gen({ prompt: 'hi there' }), RESOLVED)
    expect(result.content).toBe('hello back')
    expect(hooks.spawn_calls).toHaveLength(1)
    const call = hooks.spawn_calls[0] ?? {}
    expect(call['stdin']).toBe('hi there')
    expect(call['argv']).toEqual(expect.arrayContaining(['claude-sonnet-4-5']))
  })

  it('records option_ignored for max_steps, tool_error_policy, and on_tool_approval', async () => {
    hooks.responses = [{ lines: success_lines('ok'), close: ZERO_CLOSE }]
    const traj = create_captured_trajectory()
    const adapter = create_claude_cli_adapter({})
    await adapter.generate(
      gen({
        max_steps: 3,
        tool_error_policy: 'throw',
        on_tool_approval: () => true,
        trajectory: traj.logger,
      }),
      RESOLVED,
    )
    const ignored = traj.events.filter((e) => e.kind === 'option_ignored').map((e) => e['option'])
    expect(ignored).toEqual(expect.arrayContaining(['max_steps', 'tool_error_policy', 'on_tool_approval']))
  })

  it('records option_ignored for the salvage and clamp options it cannot honor', async () => {
    hooks.responses = [{ lines: success_lines('ok'), close: ZERO_CLOSE }]
    const traj = create_captured_trajectory()
    const adapter = create_claude_cli_adapter({})
    await adapter.generate(
      gen({
        tool_call_repair_attempts: 2,
        max_tool_calls_per_step: 1,
        trajectory: traj.logger,
      }),
      RESOLVED,
    )
    const ignored = traj.events.filter((e) => e.kind === 'option_ignored').map((e) => e['option'])
    expect(ignored).toEqual(
      expect.arrayContaining(['tool_call_repair_attempts', 'max_tool_calls_per_step']),
    )
  })

  it('rejects a multi-turn user prompt', async () => {
    const adapter = create_claude_cli_adapter({})
    const prompt: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]
    await expect(adapter.generate(gen({ prompt }), RESOLVED)).rejects.toMatchObject({
      kind: 'provider_capability_error',
      capability: 'multi_turn_history',
    })
    expect(hooks.spawn_calls).toHaveLength(0)
  })

  it('rejects only when an executable tool is present under tool_bridge forbid', async () => {
    const adapter = create_claude_cli_adapter({})
    // A mix of executable + plain: the guard must fire on the executable one.
    const tools: Tool[] = [plain_tool('plain'), exec_tool('runner')]
    let err: unknown
    try {
      await adapter.generate(gen({ tools, provider_options: { claude_cli: { tool_bridge: 'forbid' } } }), RESOLVED)
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ kind: 'provider_capability_error', capability: 'tool_execute' })
    expect((err as Error).message).toContain('forbid')
  })

  it('allows non-executable tools under tool_bridge forbid', async () => {
    hooks.responses = [{ lines: success_lines('ok'), close: ZERO_CLOSE }]
    const adapter = create_claude_cli_adapter({})
    const tools: Tool[] = [plain_tool('plain')]
    const result = await adapter.generate(
      gen({ tools, provider_options: { claude_cli: { tool_bridge: 'forbid' } } }),
      RESOLVED,
    )
    expect(result.content).toBe('ok')
  })

  it('puts tool names into the CLI allowed-tools argv', async () => {
    hooks.responses = [{ lines: success_lines('ok'), close: ZERO_CLOSE }]
    const adapter = create_claude_cli_adapter({})
    const tools: Tool[] = [plain_tool('my_special_tool')]
    await adapter.generate(gen({ tools }), RESOLVED)
    const argv = (hooks.spawn_calls[0]?.['argv'] ?? []) as string[]
    expect(argv.join(' ')).toContain('my_special_tool')
  })

  it('forwards the system prompt and a caller output_json_schema into argv', async () => {
    hooks.responses = [{ lines: success_lines('ok'), close: ZERO_CLOSE }]
    const adapter = create_claude_cli_adapter({})
    await adapter.generate(
      gen({
        system: 'SYSTEM_SENTINEL',
        provider_options: { claude_cli: { output_json_schema: '{"sentinel_schema":true}' } },
      }),
      RESOLVED,
    )
    const argv = (hooks.spawn_calls[0]?.['argv'] ?? []) as string[]
    const joined = argv.join(' ')
    expect(joined).toContain('SYSTEM_SENTINEL')
    expect(joined).toContain('sentinel_schema')
  })

  it('records the executable tools dropped under allowlist_only', async () => {
    hooks.responses = [{ lines: success_lines('ok'), close: ZERO_CLOSE }]
    const traj = create_captured_trajectory()
    const adapter = create_claude_cli_adapter({})
    const tools: Tool[] = [exec_tool('runner'), plain_tool('plain')]
    await adapter.generate(gen({ tools, trajectory: traj.logger }), RESOLVED)
    const rec = traj.events.find((e) => e.kind === 'cli_tool_bridge_allowlist_only')
    expect(rec?.['dropped']).toEqual(['runner'])
  })

  it('classifies a non-zero CLI exit as a subprocess_exit error', async () => {
    hooks.responses = [{ lines: [], close: { code: 1, signal: null, stderr: 'kaboom' } }]
    const adapter = create_claude_cli_adapter({})
    await expect(adapter.generate(gen({}), RESOLVED)).rejects.toMatchObject({
      kind: 'claude_cli_error',
      reason: 'subprocess_exit',
    })
  })

  it('errors when the CLI closes without a terminal result event', async () => {
    hooks.responses = [
      {
        lines: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' })],
        close: ZERO_CLOSE,
      },
    ]
    const adapter = create_claude_cli_adapter({})
    await expect(adapter.generate(gen({}), RESOLVED)).rejects.toMatchObject({
      kind: 'claude_cli_error',
      reason: 'no_result_event',
    })
  })

  it('passes cwd and the abort signal through to spawn', async () => {
    hooks.responses = [{ lines: success_lines('ok'), close: ZERO_CLOSE }]
    const adapter = create_claude_cli_adapter({ default_cwd: '/work' })
    const controller = new AbortController()
    await adapter.generate(gen({ abort: controller.signal }), RESOLVED)
    const call = hooks.spawn_calls[0] ?? {}
    expect(call['cwd']).toBe('/work')
    expect(call['abort']).toBeInstanceOf(AbortSignal)
  })

  it('omits cwd from spawn args when no default_cwd is configured', async () => {
    hooks.responses = [{ lines: success_lines('ok'), close: ZERO_CLOSE }]
    const adapter = create_claude_cli_adapter({})
    await adapter.generate(gen({}), RESOLVED)
    const call = hooks.spawn_calls[0] ?? {}
    expect('cwd' in call).toBe(false)
    // abort is always present: generate threads its own internal controller.
    expect(call['abort']).toBeInstanceOf(AbortSignal)
  })

  it('dispatches stream chunks including a terminal finish chunk', async () => {
    hooks.responses = [{ lines: success_lines('streamed'), close: ZERO_CLOSE }]
    const adapter = create_claude_cli_adapter({})
    const chunks: StreamChunk[] = []
    await adapter.generate(
      gen({
        on_chunk: (c) => {
          chunks.push(c)
        },
      }),
      RESOLVED,
    )
    const finish = chunks.find((c) => c.kind === 'finish')
    expect(finish).toBeDefined()
    expect((finish as { finish_reason?: unknown }).finish_reason).toBeDefined()
    expect((finish as { usage?: unknown }).usage).toBeDefined()
  })

  it('compiles a schema into argv and returns the parsed object', async () => {
    hooks.responses = [{ lines: success_lines('{"answer":"42"}'), close: ZERO_CLOSE }]
    const adapter = create_claude_cli_adapter({})
    const result = await adapter.generate(
      gen<{ answer: string }>({ schema: z.object({ answer: z.string() }) }),
      RESOLVED,
    )
    expect(result.content).toEqual({ answer: '42' })
    const argv = (hooks.spawn_calls[0]?.['argv'] ?? []) as string[]
    expect(argv.some((a) => a.includes('answer'))).toBe(true)
  })

  it('repairs an invalid schema result via a second call, then parses it', async () => {
    hooks.responses = [
      { lines: success_lines('not json', { session_id: 'sess-A' }), close: ZERO_CLOSE },
      { lines: success_lines('{"answer":"ok"}', { session_id: 'sess-A' }), close: ZERO_CLOSE },
    ]
    const adapter = create_claude_cli_adapter({})
    const result = await adapter.generate(
      gen<{ answer: string }>({ schema: z.object({ answer: z.string() }), schema_repair_attempts: 1 }),
      RESOLVED,
    )
    expect(hooks.spawn_calls).toHaveLength(2)
    expect(result.content).toEqual({ answer: 'ok' })
  })

  it('throws schema_validation_error when repair is disabled', async () => {
    hooks.responses = [{ lines: success_lines('not json'), close: ZERO_CLOSE }]
    const adapter = create_claude_cli_adapter({})
    await expect(
      adapter.generate(
        gen<{ answer: string }>({ schema: z.object({ answer: z.string() }), schema_repair_attempts: 0 }),
        RESOLVED,
      ),
    ).rejects.toMatchObject({ kind: 'schema_validation_error' })
    expect(hooks.spawn_calls).toHaveLength(1)
  })

  it('records the generate/step spans and provider-reported cost on success', async () => {
    hooks.responses = [
      {
        lines: success_lines('done', { total_cost_usd: 0.002, input_tokens: 12, output_tokens: 7 }),
        close: ZERO_CLOSE,
      },
    ]
    const traj = create_captured_trajectory()
    const adapter = create_claude_cli_adapter({})
    await adapter.generate(gen({ model: 'sonnet', trajectory: traj.logger }), RESOLVED)

    const gen_span = traj.spans.find((s) => s.name === 'engine.generate')
    expect(gen_span?.meta).toMatchObject({
      provider: 'claude_cli',
      model_id: 'claude-sonnet-4-5',
      model: 'sonnet',
      has_tools: false,
      has_schema: false,
      streaming: false,
    })
    expect(gen_span?.ended?.['finish_reason']).toBeDefined()
    expect(gen_span?.ended?.['model_resolved']).toMatchObject({
      provider: 'claude_cli',
      model_id: 'claude-sonnet-4-5',
    })

    const step_span = traj.spans.find((s) => s.name === 'engine.generate.step')
    expect(step_span?.meta).toMatchObject({ index: 0 })
    expect(step_span?.ended?.['usage']).toBeDefined()
    expect(step_span?.ended?.['finish_reason']).toBeDefined()

    const cost = traj.events.find((e) => e.kind === 'cost')
    expect(cost).toMatchObject({ step_index: 0, source: 'provider_reported' })
    expect(cost?.['total_usd']).toBeGreaterThan(0)
  })

  it('marks has_tools, has_schema, and streaming in the generate span', async () => {
    hooks.responses = [{ lines: success_lines('{"answer":"x"}'), close: ZERO_CLOSE }]
    const traj = create_captured_trajectory()
    const adapter = create_claude_cli_adapter({})
    const tools: Tool[] = [plain_tool('plain')]
    await adapter.generate(
      gen<{ answer: string }>({
        tools,
        schema: z.object({ answer: z.string() }),
        on_chunk: () => {},
        trajectory: traj.logger,
      }),
      RESOLVED,
    )
    const gen_span = traj.spans.find((s) => s.name === 'engine.generate')
    expect(gen_span?.meta).toMatchObject({ has_tools: true, has_schema: true, streaming: true })
  })

  it('ends both spans with the error message when the call fails', async () => {
    hooks.responses = [{ lines: [], close: { code: 1, signal: null, stderr: 'boom' } }]
    const traj = create_captured_trajectory()
    const adapter = create_claude_cli_adapter({})
    await expect(adapter.generate(gen({ trajectory: traj.logger }), RESOLVED)).rejects.toBeDefined()
    const gen_span = traj.spans.find((s) => s.name === 'engine.generate')
    expect(typeof gen_span?.ended?.['error']).toBe('string')
    const step_span = traj.spans.find((s) => s.name === 'engine.generate.step')
    expect(typeof step_span?.ended?.['error']).toBe('string')
  })
})
