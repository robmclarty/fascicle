import { run } from 'fascicle'
import type { Engine, GenerateOptions, GenerateResult } from 'fascicle'
import { describe, expect, it } from 'vitest'

import type { Provider } from '../../engine.js'
import { CLAUDE_CLI_BUILDER_TOOLS, make_builder_call } from '../builder.js'
import type { Handoff } from '../../types.js'

const HANDOFF_FIXTURE: Handoff = {
  files_touched: [{ path: 'src/payments.ts', one_liner: 'flip const → let' }],
  deviations: [],
  summary: 'Renamed const to let. One line, zero behavior change.',
}

type CapturedCall = {
  tools_count: number
  tool_names: ReadonlyArray<string>
  provider_options: Record<string, unknown> | undefined
}

function make_capture_engine(): { engine: Engine; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const engine: Engine = {
    generate: async <T = unknown>(opts: GenerateOptions<T>): Promise<GenerateResult<T>> => {
      const tools = opts.tools ?? []
      calls.push({
        tools_count: tools.length,
        tool_names: tools.map((t) => t.name),
        provider_options: opts.provider_options,
      })
      const parsed = opts.schema ? opts.schema.parse(HANDOFF_FIXTURE) : HANDOFF_FIXTURE
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: parsed as T,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: 'stop',
        model_resolved: { provider: 'capture', model_id: 'capture-stub' },
      }
    },
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    with_providers: () => { throw new Error("stub engine does not support with_providers") },
    dispose: async () => {},
  }
  return { engine, calls }
}

const EXPECTED_API_TOOL_NAMES = [
  'list_dir',
  'read_file',
  'write_file',
  'edit_file',
  'run_shell',
] as const

describe('make_builder_call dispatch', () => {
  it('claude_cli: schema-only path with provider_options.allowed_tools', async () => {
    const { engine, calls } = make_capture_engine()
    const step = make_builder_call(engine, 'sonnet', '/tmp/wt-cli', 'claude_cli')
    await run(step, 'noop prompt', { install_signal_handlers: false })

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call === undefined) throw new Error('expected one call')
    expect(call.tools_count).toBe(0)
    const claude_cli_opts = call.provider_options?.['claude_cli']
    expect(claude_cli_opts).toEqual({ allowed_tools: CLAUDE_CLI_BUILDER_TOOLS })
  })

  it.each<Provider>(['anthropic', 'openrouter'])(
    '%s: explicit worktree-scoped tools, no claude_cli provider_options',
    async (provider) => {
      const { engine, calls } = make_capture_engine()
      const step = make_builder_call(engine, 'sonnet', '/tmp/wt-api', provider)
      await run(step, 'noop prompt', { install_signal_handlers: false })

      expect(calls).toHaveLength(1)
      const call = calls[0]
      if (call === undefined) throw new Error('expected one call')
      expect(call.tools_count).toBe(EXPECTED_API_TOOL_NAMES.length)
      expect(call.tool_names.toSorted()).toEqual(EXPECTED_API_TOOL_NAMES.toSorted())
      expect(call.provider_options).toBeUndefined()
    },
  )
})
