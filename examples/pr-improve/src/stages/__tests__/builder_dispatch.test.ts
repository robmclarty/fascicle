import { run } from 'fascicle'
import { make_capture_engine } from 'fascicle/testing'
import { describe, expect, it } from 'vitest'

import type { Provider } from '../../engine.js'
import { CLAUDE_CLI_BUILDER_TOOLS, make_builder_step } from '../builder.js'
import type { Handoff } from '../../types.js'

const HANDOFF_FIXTURE: Handoff = {
  files_touched: [{ path: 'src/payments.ts', one_liner: 'flip const → let' }],
  deviations: [],
  summary: 'Renamed const to let. One line, zero behavior change.',
}

function capture_engine() {
  return make_capture_engine({
    result: {
      content: HANDOFF_FIXTURE,
      tool_calls: [],
      steps: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      finish_reason: 'stop',
      model_resolved: { provider: 'capture', model_id: 'capture-stub' },
    },
    // Round-trip the canned handoff through the caller's schema, so the
    // fixture cannot drift from the handoff contract.
    on_generate: async (opts) => {
      const checked = await opts.schema?.['~standard'].validate(HANDOFF_FIXTURE)
      if (checked?.issues !== undefined) throw new Error('fixture failed the handoff schema')
    },
  })
}

const EXPECTED_API_TOOL_NAMES = [
  'list_dir',
  'read_file',
  'write_file',
  'edit_file',
  'run_shell',
] as const

describe('make_builder_step dispatch', () => {
  it('claude_cli: schema-only path with provider_options.allowed_tools', async () => {
    const { engine, calls } = capture_engine()
    const step = make_builder_step(engine, 'sonnet', '/tmp/wt-cli', 'claude_cli')
    await run(step, 'noop prompt', { install_signal_handlers: false })

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call === undefined) throw new Error('expected one call')
    expect(call.tools ?? []).toHaveLength(0)
    const claude_cli_opts = call.provider_options?.['claude_cli']
    expect(claude_cli_opts).toEqual({ allowed_tools: CLAUDE_CLI_BUILDER_TOOLS })
  })

  it.each<Provider>(['anthropic', 'openrouter'])(
    '%s: explicit worktree-scoped tools, no claude_cli provider_options',
    async (provider) => {
      const { engine, calls } = capture_engine()
      const step = make_builder_step(engine, 'sonnet', '/tmp/wt-api', provider)
      await run(step, 'noop prompt', { install_signal_handlers: false })

      expect(calls).toHaveLength(1)
      const call = calls[0]
      if (call === undefined) throw new Error('expected one call')
      const tool_names = (call.tools ?? []).map((t) => t.name)
      expect(tool_names.toSorted()).toEqual(EXPECTED_API_TOOL_NAMES.toSorted())
      expect(call.provider_options).toBeUndefined()
    },
  )
})
