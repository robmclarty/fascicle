/**
 * Subprocess lifecycle tests (spec §6, constraints §5.10, §12 #12, #13, #15).
 *
 * Exercises create_spawn_runtime end-to-end with the mock binary:
 *   - mandatory spawn options (detached, stdio, shell: false, explicit env)
 *   - per-adapter live registry membership (insert at spawn, remove on close)
 *   - process.on('exit') synchronous SIGKILL over every live registry
 *   - SIGTERM → SIGKILL escalator timing (SIGKILL_ESCALATION_MS)
 *
 * All tests spawn a real Node-script mock (fixtures/mock_claude.mjs), never a
 * real 'claude' binary.
 */

import { readFile } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { create_spawn_runtime } from '../../../src/providers/claude_cli/spawn.js'
import { SIGKILL_ESCALATION_MS } from '../../../src/providers/claude_cli/constants.js'
import { aborted_error, claude_cli_error } from '../../../src/errors.js'
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

async function wait_for_exit(child: ChildProcess, timeout_ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeout_ms)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function is_alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

describe('create_spawn_runtime — spawn options (spec §6.1, §12 #1)', () => {
  it('spawns with detached process group, pipe stdio, shell:false, and explicit env', async () => {
    const handle = await track(await write_mock_script(success_ops('ok')))
    const runtime = create_spawn_runtime()
  
    const session = await runtime.spawn_cli({
      cmd: MOCK_CLAUDE_PATH,
      argv: ['-p', '--output-format', 'stream-json'],
      env: build_mock_env({
        MOCK_CLAUDE_SCRIPT: handle.script_path,
        MOCK_CLAUDE_RECORD: handle.record_path,
        MARKER_VAR: 'marker-value',
      }),
      stdin: 'hello',
      startup_timeout_ms: 0,
      stall_timeout_ms: 0,
    })
  
    // Consume stdout so the child can finish.
    for await (const _ of session.stdout_lines) void _
    await session.wait_close()
  
    expect(session.child.spawnfile).toBe(MOCK_CLAUDE_PATH)
    expect(session.child.spawnargs[0]).toBe(MOCK_CLAUDE_PATH)
    expect(session.child.spawnargs.slice(1)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
    ])
  
    const snapshot = JSON.parse(await readFile(handle.record_path, 'utf8')) as {
      argv: string[]
      env: Record<string, string>
    }
    expect(snapshot.argv).toEqual(['-p', '--output-format', 'stream-json'])
    expect(snapshot.env['MARKER_VAR']).toBe('marker-value')
    // Parent-process-only vars should not leak through explicit env.
    expect(snapshot.env['VITEST']).toBeUndefined()
  })

  it('detached: child runs as its own process-group leader', async () => {
    const handle = await track(
      await write_mock_script([{ op: 'hang' }]),
    )
    const runtime = create_spawn_runtime()
  
    const session = await runtime.spawn_cli({
      cmd: MOCK_CLAUDE_PATH,
      argv: [],
      env: build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path }),
      stdin: '',
      startup_timeout_ms: 0,
      stall_timeout_ms: 0,
    })
  
    const pid = session.child.pid
    expect(pid).toBeTypeOf('number')
    if (pid !== undefined) {
      // process.kill(-pid, 0) succeeds iff a process group led by `pid`
      // exists. `detached: true` creates such a group (setsid).
      expect(() => process.kill(-pid, 0)).not.toThrow()
    }
  
    session.request_terminate('disposed')
    await wait_for_exit(session.child, 5000)
    await session.wait_close().catch(() => undefined)
    await runtime.dispose_all()
  })

  it('wait_close throws claude_cli_error when binary cannot be spawned', async () => {
    const runtime = create_spawn_runtime()
    // Node spawn emits ENOENT asynchronously via the child's 'error' event;
    // the adapter surfaces it at wait_close() as claude_cli_error.
    const session = await runtime.spawn_cli({
      cmd: '/nonexistent/path/to/claude-binary-xyz',
      argv: [],
      env: {},
      stdin: '',
      startup_timeout_ms: 0,
      stall_timeout_ms: 0,
    })
    for await (const _ of session.stdout_lines) void _
    await expect(session.wait_close()).rejects.toThrow(claude_cli_error)
    await runtime.dispose_all()
  })

  it('rejects synchronously when abort signal is already aborted', async () => {
    const runtime = create_spawn_runtime()
    const ctrl = new AbortController()
    ctrl.abort(new Error('pre-aborted'))
  
    await expect(
      runtime.spawn_cli({
        cmd: MOCK_CLAUDE_PATH,
        argv: [],
        env: {},
        stdin: '',
        startup_timeout_ms: 0,
        stall_timeout_ms: 0,
        abort: ctrl.signal,
      }),
    ).rejects.toThrow(aborted_error)
    await runtime.dispose_all()
  })
})

describe('live_children registry (spec §6, constraints §7 invariant 5)', () => {
  it('inserts on spawn; removes on close', async () => {
    const handle = await track(await write_mock_script(success_ops('ok')))
    const runtime = create_spawn_runtime()
  
    const session = await runtime.spawn_cli({
      cmd: MOCK_CLAUDE_PATH,
      argv: [],
      env: build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path }),
      stdin: '',
      startup_timeout_ms: 0,
      stall_timeout_ms: 0,
    })
  
    expect(runtime.live_children.has(session.child)).toBe(true)
  
    // drain + close.
    for await (const _ of session.stdout_lines) void _
    await session.wait_close()
    await wait_for_exit(session.child, 2000)
  
    expect(runtime.live_children.has(session.child)).toBe(false)
    await runtime.dispose_all()
  })

  it('each create_spawn_runtime() has its own independent registry', async () => {
    const handle_a = await track(await write_mock_script(success_ops('a')))
    const handle_b = await track(await write_mock_script(success_ops('b')))
    const rt_a = create_spawn_runtime()
    const rt_b = create_spawn_runtime()
  
    expect(rt_a.live_children).not.toBe(rt_b.live_children)
  
    const sa = await rt_a.spawn_cli({
      cmd: MOCK_CLAUDE_PATH,
      argv: [],
      env: build_mock_env({ MOCK_CLAUDE_SCRIPT: handle_a.script_path }),
      stdin: '',
      startup_timeout_ms: 0,
      stall_timeout_ms: 0,
    })
    const sb = await rt_b.spawn_cli({
      cmd: MOCK_CLAUDE_PATH,
      argv: [],
      env: build_mock_env({ MOCK_CLAUDE_SCRIPT: handle_b.script_path }),
      stdin: '',
      startup_timeout_ms: 0,
      stall_timeout_ms: 0,
    })
  
    expect(rt_a.live_children.has(sa.child)).toBe(true)
    expect(rt_a.live_children.has(sb.child)).toBe(false)
    expect(rt_b.live_children.has(sb.child)).toBe(true)
    expect(rt_b.live_children.has(sa.child)).toBe(false)
  
    const drain_a = (async (): Promise<void> => {
      for await (const _ of sa.stdout_lines) void _
    })()
    const drain_b = (async (): Promise<void> => {
      for await (const _ of sb.stdout_lines) void _
    })()
    await Promise.all([drain_a, drain_b])
    await sa.wait_close()
    await sb.wait_close()
    await rt_a.dispose_all()
    await rt_b.dispose_all()
  })
})

describe('process.on("exit") reap (spec §6, §12 #15 constraints §5.10 #5)', () => {
  it('registers exactly one exit listener across many runtimes', () => {
    const before = process.listenerCount('exit')
    const a = create_spawn_runtime()
    const b = create_spawn_runtime()
    const c = create_spawn_runtime()
    const after = process.listenerCount('exit')
    // install_exit_handler_once is a singleton; multiple runtimes add zero or one.
    expect(after - before).toBeLessThanOrEqual(1)
    cleanup_stack.push(() => a.dispose_all())
    cleanup_stack.push(() => b.dispose_all())
    cleanup_stack.push(() => c.dispose_all())
  })

  it('invoking the exit handler synchronously SIGKILLs every live child', async () => {
    const handle = await track(
      await write_mock_script([{ op: 'hang' }]),
    )
    const runtime = create_spawn_runtime()
  
    const session = await runtime.spawn_cli({
      cmd: MOCK_CLAUDE_PATH,
      argv: [],
      env: build_mock_env({
        MOCK_CLAUDE_SCRIPT: handle.script_path,
        MOCK_CLAUDE_IGNORE_SIGTERM: '1',
      }),
      stdin: '',
      startup_timeout_ms: 0,
      stall_timeout_ms: 0,
    })
  
    expect(is_alive(session.child)).toBe(true)
  
    // The exit handler is registered by install_exit_handler_once; invoking all
    // 'exit' listeners simulates the node process termination path.
    const listeners = process.listeners('exit')
    for (const fn of listeners) {
      try {
        (fn as (code: number) => void)(0)
      } catch {
        // swallow — we're only invoking handlers to validate claude_cli's one.
      }
    }
  
    // Give the kernel a beat to deliver SIGKILL.
    await wait_for_exit(session.child, 2000)
    expect(is_alive(session.child)).toBe(false)
    expect(session.child.signalCode).toBe('SIGKILL')
  
    await session.wait_close().catch(() => undefined)
    await runtime.dispose_all()
  })
})

describe('SIGTERM → SIGKILL escalator (spec §6.3, §12 #13)', () => {
  it(
    'child that ignores SIGTERM is killed by SIGKILL after SIGKILL_ESCALATION_MS',
    async () => {
      const handle = await track(
        await write_mock_script([{ op: 'hang' }]),
      )
      const runtime = create_spawn_runtime()
  
      const session = await runtime.spawn_cli({
        cmd: MOCK_CLAUDE_PATH,
        argv: [],
        env: build_mock_env({
          MOCK_CLAUDE_SCRIPT: handle.script_path,
          MOCK_CLAUDE_IGNORE_SIGTERM: '1',
        }),
        stdin: '',
        startup_timeout_ms: 0,
        stall_timeout_ms: 0,
      })
  
      // Give the child time to install its SIGTERM handler before we signal.
      await new Promise((r) => setTimeout(r, 150))
  
      const start = Date.now()
      session.request_terminate('disposed')
  
      // At 1000ms elapsed (well before SIGKILL_ESCALATION_MS = 2000), child
      // should still be alive because it ignores SIGTERM.
      await new Promise((r) => setTimeout(r, 1000))
      expect(is_alive(session.child)).toBe(true)
  
      // Now wait up to the escalation window + margin for SIGKILL.
      await wait_for_exit(session.child, SIGKILL_ESCALATION_MS + 1500)
      const elapsed = Date.now() - start
  
      expect(is_alive(session.child)).toBe(false)
      expect(session.child.signalCode).toBe('SIGKILL')
      expect(elapsed).toBeGreaterThanOrEqual(SIGKILL_ESCALATION_MS - 200)
  
      await expect(session.wait_close()).rejects.toThrow(aborted_error)
      await runtime.dispose_all()
    },
    10_000,
  )

  it('child that honors SIGTERM exits quickly on request_terminate', async () => {
    const handle = await track(
      await write_mock_script([{ op: 'hang' }]),
    )
    const runtime = create_spawn_runtime()
  
    const session = await runtime.spawn_cli({
      cmd: MOCK_CLAUDE_PATH,
      argv: [],
      env: build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path }),
      stdin: '',
      startup_timeout_ms: 0,
      stall_timeout_ms: 0,
    })
  
    const start = Date.now()
    session.request_terminate('abort')
    await wait_for_exit(session.child, 3000)
    const elapsed = Date.now() - start
  
    expect(is_alive(session.child)).toBe(false)
    // Well under the 2s SIGKILL escalation window.
    expect(elapsed).toBeLessThan(SIGKILL_ESCALATION_MS)
    await session.wait_close().catch(() => undefined)
    await runtime.dispose_all()
  })
})

describe('dispose_all (spec §6)', () => {
  it('terminates every live child and removes the registry', async () => {
    const handle = await track(
      await write_mock_script([{ op: 'hang' }]),
    )
    const runtime = create_spawn_runtime()
  
    const s1 = await runtime.spawn_cli({
      cmd: MOCK_CLAUDE_PATH,
      argv: [],
      env: build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path }),
      stdin: '',
      startup_timeout_ms: 0,
      stall_timeout_ms: 0,
    })
    const s2 = await runtime.spawn_cli({
      cmd: MOCK_CLAUDE_PATH,
      argv: [],
      env: build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path }),
      stdin: '',
      startup_timeout_ms: 0,
      stall_timeout_ms: 0,
    })
  
    expect(runtime.live_children.size).toBe(2)
  
    await runtime.dispose_all()
  
    expect(is_alive(s1.child)).toBe(false)
    expect(is_alive(s2.child)).toBe(false)
    await s1.wait_close().catch(() => undefined)
    await s2.wait_close().catch(() => undefined)
  })
})
