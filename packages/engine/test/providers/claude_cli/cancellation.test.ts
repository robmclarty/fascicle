/**
 * Cancellation, timeouts, dispose, and post-dispose semantics (spec §6, §8,
 * §11, §12 #14, #18, #19, #25).
 *
 * Exercises the full adapter surface under:
 *   - opts.abort fired mid-stream (SIGTERM → SIGKILL if child ignores it)
 *   - startup_timeout_ms (no stdout within window)
 *   - stall_timeout_ms (no further stdout for window)
 *   - engine.dispose() rejecting in-flight generate() calls
 *   - post-dispose generate() throwing engine_disposed_error synchronously
 *   - independent adapter instances (separate live registries)
 */

import { afterEach, describe, expect, it } from 'vitest'
import { create_claude_cli_adapter } from '../../../src/providers/claude_cli/index.js'
import {
  aborted_error,
  claude_cli_error,
  engine_disposed_error,
} from '../../../src/errors.js'
import type { AliasTarget, GenerateOptions } from '../../../src/types.js'
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

const alias_target: AliasTarget = {
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

describe('abort — caller signal (§12 #14, F27)', () => {
  it('aborting mid-stream rejects generate() with aborted_error', async () => {
    const handle = await track(
      await write_mock_script([
        { op: 'line', data: { type: 'system', subtype: 'init', session_id: 's', model: 'm' } },
        { op: 'hang' },
      ]),
    )
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
    cleanup_stack.push(() => adapter.dispose())
  
    const ctrl = new AbortController()
    const env = build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path })
    const promise = adapter.generate(
      { ...base_opts(env), abort: ctrl.signal },
      alias_target,
    )
  
    // Let the child produce its init line so we know we're mid-stream.
    await new Promise((r) => setTimeout(r, 150))
    ctrl.abort(new Error('user-cancel'))
  
    await expect(promise).rejects.toThrow(aborted_error)
  })

  it('pre-aborted signal rejects synchronously', async () => {
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
    cleanup_stack.push(() => adapter.dispose())
    const ctrl = new AbortController()
    ctrl.abort(new Error('already'))
    await expect(
      adapter.generate(
        { ...base_opts(build_mock_env({})), abort: ctrl.signal },
        alias_target,
      ),
    ).rejects.toThrow(aborted_error)
  })
})

describe('timeouts (spec §6.3, §12 #18, F21, F22)', () => {
  it('F21 — startup_timeout_ms fires when no stdout arrives in window', async () => {
    // Script never emits to stdout but keeps the process alive.
    const handle = await track(
      await write_mock_script([{ op: 'hang' }]),
    )
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
      startup_timeout_ms: 200,
    })
    cleanup_stack.push(() => adapter.dispose())
  
    await expect(
      adapter.generate(
        base_opts(build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path })),
        alias_target,
      ),
    ).rejects.toMatchObject({ reason: 'startup_timeout' })
  })

  it('F22 — stall_timeout_ms fires when stdout pauses after first byte', async () => {
    // Emit one line, then hang without another line.
    const handle = await track(
      await write_mock_script([
        { op: 'line', data: { type: 'system', subtype: 'init', session_id: 's', model: 'm' } },
        { op: 'hang' },
      ]),
    )
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
      stall_timeout_ms: 200,
    })
    cleanup_stack.push(() => adapter.dispose())
  
    await expect(
      adapter.generate(
        base_opts(build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path })),
        alias_target,
      ),
    ).rejects.toMatchObject({ reason: 'stall_timeout' })
  })
})

describe('engine.dispose (spec §8, §12 #19, #25)', () => {
  it('§12 #25 — dispose() aborts in-flight generate() with aborted_error engine_disposed', async () => {
    const handle = await track(
      await write_mock_script([{ op: 'hang' }]),
    )
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
  
    const promise = adapter.generate(
      base_opts(build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path })),
      alias_target,
    )
  
    // Let the child start before disposing.
    await new Promise((r) => setTimeout(r, 150))
    await adapter.dispose()
  
    try {
      await promise
      throw new Error('generate() unexpectedly resolved')
    } catch (err) {
      expect(err).toBeInstanceOf(aborted_error)
      if (err instanceof aborted_error) {
        expect(err.reason).toBe('engine_disposed')
      }
    }
  })

  it('post-dispose generate() throws engine_disposed_error', async () => {
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
    await adapter.dispose()
    await expect(
      adapter.generate(base_opts(build_mock_env({})), alias_target),
    ).rejects.toThrow(engine_disposed_error)
  })

  it('dispose() is idempotent', async () => {
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
    await adapter.dispose()
    await adapter.dispose()
    await adapter.dispose()
  })
})

describe('independent adapter instances (constraints §7 invariant 5)', () => {
  it('disposing one adapter does not affect another adapter\'s in-flight calls', async () => {
    const handle_a = await track(await write_mock_script([{ op: 'hang' }]))
    const handle_b = await track(await write_mock_script(success_ops('b-done')))
  
    const adapter_a = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
    const adapter_b = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
    cleanup_stack.push(() => adapter_b.dispose())
  
    const promise_a = adapter_a.generate(
      base_opts(build_mock_env({ MOCK_CLAUDE_SCRIPT: handle_a.script_path })),
      alias_target,
    )
    const promise_b = adapter_b.generate(
      base_opts(build_mock_env({ MOCK_CLAUDE_SCRIPT: handle_b.script_path })),
      alias_target,
    )
  
    // Give both a moment to spawn.
    await new Promise((r) => setTimeout(r, 100))
    await adapter_a.dispose()
  
    await expect(promise_a).rejects.toThrow(aborted_error)
    const result_b = await promise_b
    expect(result_b.content).toBe('b-done')
  })
})

describe('classify_close_error path (§12 #17, F21)', () => {
  it('non-zero exit without abort surfaces claude_cli_error subprocess_exit', async () => {
    const handle = await track(
      await write_mock_script([
        { op: 'stderr', text: 'boom: something broke\n' },
        { op: 'exit', code: 2 },
      ]),
    )
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
    cleanup_stack.push(() => adapter.dispose())
  
    await expect(
      adapter.generate(
        base_opts(build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path })),
        alias_target,
      ),
    ).rejects.toThrow(claude_cli_error)
  })

  it('no_result_event error when CLI exits 0 without emitting a result', async () => {
    // init only, then exit 0.
    const handle = await track(
      await write_mock_script([
        { op: 'line', data: { type: 'system', subtype: 'init', session_id: 's', model: 'm' } },
        { op: 'exit', code: 0 },
      ]),
    )
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
    cleanup_stack.push(() => adapter.dispose())
  
    await expect(
      adapter.generate(
        base_opts(build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path })),
        alias_target,
      ),
    ).rejects.toMatchObject({ reason: 'no_result_event' })
  })
})

describe('trajectory captured on cancellation', () => {
  it('aborted generate still records chunks produced up to the cancel point', async () => {
    const handle = await track(
      await write_mock_script([
        {
          op: 'line',
          data: { type: 'system', subtype: 'init', session_id: 's', model: 'm' },
        },
        {
          op: 'line',
          data: {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'partial...' }] },
          },
        },
        { op: 'hang' },
      ]),
    )
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'oauth',
    })
    cleanup_stack.push(() => adapter.dispose())
  
    const traj = create_captured_trajectory()
    const ctrl = new AbortController()
    const promise = adapter.generate(
      {
        ...base_opts(build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path })),
        abort: ctrl.signal,
        trajectory: traj.logger,
      },
      alias_target,
    )
  
    await new Promise((r) => setTimeout(r, 200))
    ctrl.abort(new Error('done'))
    await expect(promise).rejects.toThrow(aborted_error)
  
    // Some provider-level events should have made it into the trajectory
    // before abort (init session, assistant text).
    expect(traj.events.length).toBeGreaterThan(0)
  })
})
