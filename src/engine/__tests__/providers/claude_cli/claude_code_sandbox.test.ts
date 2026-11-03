/**
 * Claude Code sandbox tests against the mock binary.
 *
 * A `claude_code` sandbox spawns the claude binary itself, so the mock
 * records the `--settings` JSON that the real CLI would enforce. The
 * version gate's `--version` spawn runs first and leaves the record alone.
 */

import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { claude_cli_error } from '../../../errors.js'
import { create_claude_cli_adapter } from '../../../providers/claude_cli/index.js'
import { render_sandbox_settings } from '../../../providers/claude_cli/settings.js'
import type { GenerateOptions, ResolvedModel } from '../../../types.js'
import {
  MOCK_CLAUDE_PATH,
  build_mock_env,
  success_ops,
  write_mock_script,
  type MockScriptHandle,
} from './fixtures/mock_helpers.js'

const cleanup_stack: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup_stack.length > 0) {
    const fn = cleanup_stack.pop()
    if (fn !== undefined) await fn()
  }
})

async function track(handle: MockScriptHandle): Promise<MockScriptHandle> {
  cleanup_stack.push(handle.cleanup)
  return handle
}

const alias_target: ResolvedModel = {
  provider: 'claude_cli',
  model_id: 'claude-sonnet-4-6',
}

const sandbox = {
  kind: 'claude_code',
  network_allowlist: ['openrouter.ai'],
  deny_read_paths: ['~/.ssh'],
} as const

function call_opts(env: Record<string, string>): GenerateOptions<unknown> {
  return {
    model: 'claude-sonnet-4-6',
    prompt: 'hello',
    provider_options: { claude_cli: { env } },
  }
}

describe('claude_code sandbox, through the mock binary', () => {
  it('passes the policy to claude itself, with no wrapper in front', async () => {
    const handle = await track(await write_mock_script(success_ops('ok')))
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
      sandbox,
    })
    cleanup_stack.push(() => adapter.dispose())

    const result = await adapter.generate(
      call_opts(build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path, MOCK_CLAUDE_RECORD: handle.record_path })),
      alias_target,
    )
    expect(result.content).toBe('ok')

    const record = JSON.parse(await readFile(handle.record_path, 'utf8')) as { argv: string[] }
    expect(record.argv[0]).toBe('-p')
    const settings_at = record.argv.indexOf('--settings')
    expect(record.argv[settings_at + 1]).toBe(render_sandbox_settings(sandbox))
    expect(record.argv[settings_at + 2]).toBe('--strict-mcp-config')
  })

  it('refuses a CLI older than the floor before the run spawns', async () => {
    const handle = await track(await write_mock_script(success_ops('ok')))
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
      sandbox,
    })
    cleanup_stack.push(() => adapter.dispose())

    const err = await adapter
      .generate(
        call_opts(
          build_mock_env({
            MOCK_CLAUDE_SCRIPT: handle.script_path,
            MOCK_CLAUDE_RECORD: handle.record_path,
            MOCK_CLAUDE_VERSION: '2.1.300 (Claude Code)',
          }),
        ),
        alias_target,
      )
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(claude_cli_error)
    if (err instanceof claude_cli_error) {
      expect(err.reason).toBe('sandbox_unavailable')
      expect(err.message).toBe(
        'Claude Code 2.1.300 is older than 2.1.314, the first release that honors every setting the claude_code sandbox needs: run claude update, or point providers.claude_cli.binary at a newer claude',
      )
    }
    await expect(readFile(handle.record_path, 'utf8')).rejects.toThrow()
  })
})
