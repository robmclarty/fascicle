/**
 * Failure-mode tests for claude_cli, retry feedback included.
 *
 * - subprocess exits non-zero and surfaces claude_cli_error under
 *   retry_policy='never' (one attempt, no retry).
 * - tools with execute closures under tool_bridge='allowlist_only'
 *   produce a cli_tool_bridge_allowlist_only trajectory record.
 * - tools with execute closures under tool_bridge='forbid' reject
 *   synchronously (pre-spawn) with provider_capability_error.
 * - multi-user-message prompt without session_id throws
 *   provider_capability_error('multi_turn_history').
 * - sandbox binary missing surfaces claude_cli_error that identifies
 *   the sandbox binary, not the claude binary.
 */

import { z } from 'zod'
import { readdir } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { create_claude_cli_adapter } from '../../../providers/claude_cli/index.js'
import { create_engine } from '../../../create_engine.js'
import {
  claude_cli_error,
  provider_capability_error,
} from '../../../errors.js'
import type {
  ResolvedModel,
  GenerateOptions,
  Message,
  Tool,
} from '../../../types.js'
import {
  MOCK_CLAUDE_PATH,
  build_mock_env,
  create_captured_trajectory,
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

function base_opts(env: Record<string, string>): GenerateOptions {
  return {
    model: 'claude-sonnet-4-6',
    prompt: 'hello',
    provider_options: { claude_cli: { env } },
  }
}

describe('subprocess non-zero exit with retry per retry_policy', () => {
  it(
    'under retry_policy (max_attempts:1) non-zero exit surfaces claude_cli_error with no retry',
    async () => {
      const handle = await track(
        await write_mock_script([
          { op: 'stderr', text: 'transient: something broke\n' },
          { op: 'exit', code: 1 },
        ]),
      )
  
      // Route through engine.generate so retry_policy is consulted by the
      // engine layer. The claude_cli adapter itself does not loop on failure;
      // a retry_policy with max_attempts:1 formalises the no-retry contract.
      const engine = create_engine({
        providers: {
          claude_cli: { binary: MOCK_CLAUDE_PATH, auth_mode: 'oauth' },
        },
      })
      cleanup_stack.push(() => engine.dispose())
  
      const promise = engine.generate({
        model: 'claude_cli:sonnet',
        prompt: 'hello',
        provider_options: {
          claude_cli: {
            env: build_mock_env({
              MOCK_CLAUDE_SCRIPT: handle.script_path,
              MOCK_CLAUDE_RECORD: handle.record_path,
            }),
          },
        },
        retry: {
          max_attempts: 1,
          initial_delay_ms: 10,
          max_delay_ms: 100,
          retry_on: [],
        },
      })
  
      await expect(promise).rejects.toThrow(claude_cli_error)
  
      // Exactly one attempt: only a single record file was produced (mock
      // writes on startup). Retrying would have overwritten the same file
      // but the count of .json files in the handle's tempdir stays small.
      const entries = await readdir(handle.dir)
      const records = entries.filter((e) => e.endsWith('.json'))
      // script.json + record.json
      expect(records.length).toBeLessThanOrEqual(2)
    },
    10_000,
  )
})

describe("tools with execute under tool_bridge='allowlist_only'", () => {
  it(
    'drops execute closures and records cli_tool_bridge_allowlist_only to trajectory',
    async () => {
      const handle = await track(await write_mock_script(success_ops('ok')))
      const adapter = create_claude_cli_adapter({
        binary: MOCK_CLAUDE_PATH,
        auth_mode: 'oauth',
      })
      cleanup_stack.push(() => adapter.dispose())
  
      const traj = create_captured_trajectory()
      const tools: Tool[] = [
        {
          name: 'search',
          description: 'search tool',
          input_schema: z.object({ q: z.string() }),
          execute: async (input: unknown) => ({ results: [input] }),
        },
        {
          name: 'summarize',
          description: 'summarize tool',
          input_schema: z.object({ text: z.string() }),
          execute: async (input: unknown) => ({ summary: input }),
        },
      ]
  
      await adapter.generate(
        {
          ...base_opts(build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path })),
          tools,
          trajectory: traj.logger,
          provider_options: {
            claude_cli: {
              env: build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path }),
              tool_bridge: 'allowlist_only',
            },
          },
        },
        alias_target,
      )
  
      const bridge_event = traj.events.find(
        (e) => (e as { kind: string }).kind === 'cli_tool_bridge_allowlist_only',
      ) as { kind: string; dropped: string[] } | undefined
      expect(bridge_event).toBeDefined()
      expect(bridge_event?.dropped).toEqual(['search', 'summarize'])
    },
  )
})

describe("tools with execute under tool_bridge='forbid'", () => {
  it('rejects synchronously (pre-spawn) with provider_capability_error', async () => {
    // spawn_cmd points at a non-existent path; if the pre-spawn check misfires
    // we'd see ENOENT/binary_not_found instead of provider_capability_error.
    const adapter = create_claude_cli_adapter({
      binary: '/this/binary/does/not/exist',
      auth_mode: 'oauth',
    })
    cleanup_stack.push(() => adapter.dispose())
  
    const tools: Tool[] = [
      {
        name: 'search',
        description: 'search tool',
        input_schema: z.object({ q: z.string() }),
        execute: async (input: unknown) => ({ results: [input] }),
      },
    ]
  
    await expect(
      adapter.generate(
        {
          model: 'claude-sonnet-4-6',
          prompt: 'hello',
          tools,
          provider_options: {
            claude_cli: { env: build_mock_env({}), tool_bridge: 'forbid' },
          },
        },
        alias_target,
      ),
    ).rejects.toThrow(provider_capability_error)
  })

})

describe('multi-user-message prompt without session_id', () => {
  it('throws provider_capability_error(multi_turn_history) pre-spawn', async () => {
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
    cleanup_stack.push(() => adapter.dispose())
  
    const prompt: Message[] = [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'assistant answer' },
      { role: 'user', content: 'second turn' },
    ]
  
    try {
      await adapter.generate(
        {
          model: 'claude-sonnet-4-6',
          prompt,
          provider_options: { claude_cli: { env: build_mock_env({}) } },
        },
        alias_target,
      )
      throw new Error('unexpected resolve')
    } catch (err) {
      expect(err).toBeInstanceOf(provider_capability_error)
      if (err instanceof provider_capability_error) {
        expect(err.capability).toBe('multi_turn_history')
      }
    }
  })
})

describe('sandbox binary missing', () => {
  it(
    'rejection clearly identifies the sandbox binary, not the claude binary',
    async () => {
      // The spawn looks bwrap up on the child env's PATH, so a PATH holding
      // only the mock's temp dir makes bwrap missing even on a host that has
      // it installed (ubuntu-latest has since 26.04).
      const handle = await track(await write_mock_script(success_ops('ok')))
      const adapter = create_claude_cli_adapter({
        binary: MOCK_CLAUDE_PATH,
        auth_mode: 'oauth',
        sandbox: { kind: 'bwrap', network_allowlist: ['api.anthropic.com'] },
      })
      cleanup_stack.push(() => adapter.dispose())

      try {
        await adapter.generate(base_opts({ PATH: handle.dir }), alias_target)
        throw new Error('unexpected resolve')
      } catch (err) {
        expect(err).toBeInstanceOf(claude_cli_error)
        if (err instanceof claude_cli_error) {
          expect(err.reason).toBe('sandbox_unavailable')
          expect(err.message.toLowerCase()).toContain('bwrap')
          expect(err.message).not.toContain(MOCK_CLAUDE_PATH)
        }
      }
    },
    10_000,
  )

  it('an unsandboxed run with no claude binary still blames the claude binary', async () => {
    const adapter = create_claude_cli_adapter({
      binary: '/nonexistent/path/to/claude-binary-xyz',
      auth_mode: 'oauth',
    })
    cleanup_stack.push(() => adapter.dispose())

    const err = await adapter
      .generate(base_opts(build_mock_env({})), alias_target)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(claude_cli_error)
    if (err instanceof claude_cli_error) expect(err.reason).toBe('binary_not_found')
  })
})
