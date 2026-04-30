/**
 * Subprocess-leak hermeticity (criterion 11).
 *
 * Creates an Engine via create_engine, fires N (=5) concurrent engine.generate
 * calls against hanging mock children, aborts a proper subset mid-stream, then
 * calls engine.dispose(). Asserts that:
 *
 *   - every aborted call rejects with aborted_error (caller reason);
 *   - every surviving (non-aborted) call rejects with aborted_error whose
 *     reason === 'engine_disposed' (dispose path);
 *   - every spawned child is dead after dispose resolves (process.kill(pid, 0)
 *     throws ESRCH) — i.e., the live registry is empty at the OS level;
 *   - post-dispose engine.generate(...) throws engine_disposed_error
 *     synchronously (still catchable via .rejects).
 *
 * Each generate call is routed through a unique record path so we can recover
 * the OS pid of every child that was actually spawned (as opposed to guessing).
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { create_engine } from '../../../src/create_engine.js'
import { aborted_error, engine_disposed_error } from '../../../src/errors.js'
import {
  MOCK_CLAUDE_PATH,
  build_mock_env,
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

async function wait_for_file(path: string, timeout_ms: number): Promise<void> {
  const deadline = Date.now() + timeout_ms
  while (Date.now() < deadline) {
    try {
      await stat(path)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  throw new Error(`file never appeared at ${path}`)
}

function pid_is_alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH → no such process; EPERM → process exists but we cannot signal
    // (should not happen for a child we spawned, but treat as alive to be
    // conservative).
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

describe('subprocess-leak hermeticity (criterion 11, §6)', () => {
  it(
    'engine.dispose() after aborting a subset of N=5 concurrent engine.generate calls reaps every child',
    async () => {
      const N = 5
      // Each generate call gets its own hanging-mock handle so record_path is
      // unique and we can read back the pid of the actual child that spawned.
      const handles: MockScriptHandle[] = []
      for (let i = 0; i < N; i += 1) {
        handles.push(
          await track(
            await write_mock_script([
              {
                op: 'line',
                data: {
                  type: 'system',
                  subtype: 'init',
                  session_id: `s${i}`,
                  model: 'mock',
                },
              },
              { op: 'hang' },
            ]),
          ),
        )
      }
  
      const engine = create_engine({
        providers: { claude_cli: { binary: MOCK_CLAUDE_PATH, auth_mode: 'oauth' } },
      })
  
      const controllers: AbortController[] = []
      // Each entry resolves to the rejection error (or `null` on unexpected
      // resolve). Attaching the .catch synchronously prevents vitest from
      // seeing unhandled-rejection warnings while we defer assertions until
      // after engine.dispose() has reaped every child.
      const settlements: Array<Promise<unknown>> = []
      for (let i = 0; i < N; i += 1) {
        const ctrl = new AbortController()
        controllers.push(ctrl)
        const h = handles[i]!
        const p = engine.generate({
          model: 'cli-sonnet',
          prompt: `hello-${i}`,
          abort: ctrl.signal,
          provider_options: {
            claude_cli: {
              env: build_mock_env({
                MOCK_CLAUDE_SCRIPT: h.script_path,
                MOCK_CLAUDE_RECORD: h.record_path,
              }),
            },
          },
        })
        settlements.push(
          p.then(
            () => null,
            (err: unknown) => err,
          ),
        )
      }
  
      // Wait until every child has spawned and recorded its pid.
      await Promise.all(
        handles.map((h) => wait_for_file(h.record_path, 15_000)),
      )
  
      const pids: number[] = []
      for (const h of handles) {
        const snapshot = JSON.parse(
          await readFile(h.record_path, 'utf8'),
        ) as { pid: number }
        expect(typeof snapshot.pid).toBe('number')
        pids.push(snapshot.pid)
      }
      // All five are alive right now, and all five pids are distinct.
      expect(new Set(pids).size).toBe(N)
      for (const pid of pids) expect(pid_is_alive(pid)).toBe(true)
  
      // Abort indices 0 and 1 mid-stream (proper non-empty subset).
      const aborted_indices = [0, 1] as const
      const surviving_indices = [2, 3, 4] as const
      for (const i of aborted_indices) controllers[i]!.abort(new Error('caller-cancel'))
  
      // Now dispose the engine. Surviving in-flight calls should flip to
      // aborted_error with reason='engine_disposed'.
      await engine.dispose()
  
      // Drain all settlements now that everything is resolved. Both subsets
      // must have rejected with aborted_error; surviving indices carry
      // reason='engine_disposed'.
      const outcomes = await Promise.all(settlements)
      for (const i of aborted_indices) {
        expect(outcomes[i]).toBeInstanceOf(aborted_error)
      }
      for (const i of surviving_indices) {
        const err = outcomes[i]
        expect(err).toBeInstanceOf(aborted_error)
        if (err instanceof aborted_error) {
          expect(err.reason).toBe('engine_disposed')
        }
      }
  
      // Every child must be gone — dispose_all awaits each child's 'close'
      // event, so by the time engine.dispose() resolves, process.kill(pid, 0)
      // must throw ESRCH for every pid we captured.
      for (const pid of pids) {
        expect(
          pid_is_alive(pid),
          `pid ${pid} is still alive after engine.dispose()`,
        ).toBe(false)
      }
  
      // Post-dispose generate() throws synchronously. We catch it in a try
      // block rather than awaiting, to prove the throw is sync.
      let threw_sync = false
      try {
        // Deliberately no await: the call site must throw before returning a
        // Promise.
        const p = engine.generate({
          model: 'cli-sonnet',
          prompt: 'after-dispose',
          provider_options: {
            claude_cli: { env: build_mock_env({}) },
          },
        })
        // If we got here the engine returned a promise rather than throwing;
        // fail loudly.
        await p.catch(() => undefined)
      } catch (err) {
        threw_sync = true
        expect(err).toBeInstanceOf(engine_disposed_error)
      }
      expect(threw_sync, 'engine.generate should throw synchronously after dispose').toBe(true)
  
      // sanity: handles' temp dirs exist (cleanup happens in afterEach).
      for (const h of handles) {
        await stat(join(h.dir, 'script.json'))
      }
    },
    30_000,
  )
})
