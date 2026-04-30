/**
 * Engine SIGINT harness (spec §10 / criterion 10).
 *
 * Spawns a child-process script that runs an engine-backed flow with a mocked
 * `ai` module (see ai-stub.mjs). The flow hangs inside `engine.generate`;
 * SIGINT reaches the runner, which aborts its controller, which propagates
 * into the engine's internal controller, which cancels the stubbed stream.
 * The child asserts:
 *   - generate rejected with engine.aborted_error;
 *   - both cleanup handlers fired (LIFO order observed via marker files);
 *   - the process exited non-zero.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const child_script = join(here, 'child-harness.ts')
const register_script = join(here, 'register-ts-resolver.mjs')

async function wait_for_marker(path: string, timeout_ms: number): Promise<void> {
  const deadline = Date.now() + timeout_ms
  let last_error: unknown = null
  while (Date.now() < deadline) {
    try {
      await stat(path)
      return
    } catch (err) {
      last_error = err
      await new Promise((resolve) => {
        setTimeout(resolve, 25)
      })
    }
  }
  throw new Error(
    `marker never appeared at ${path}: ${last_error instanceof Error ? last_error.message : String(last_error)}`,
  )
}

type ChildExit = {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}

async function spawn_child(marker_dir: string): Promise<{
  pid: number
  exit: Promise<ChildExit>
}> {
  const child = spawn(
    process.execPath,
    ['--import', register_script, child_script],
    {
      cwd: here,
      env: { ...process.env, MARKER_DIR: marker_dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  if (child.pid === undefined) {
    throw new Error('child failed to spawn')
  }

  const exit = new Promise<ChildExit>((resolve) => {
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr, stdout })
    })
  })

  return { pid: child.pid, exit }
}

describe('engine SIGINT harness', () => {
  it('SIGINT during a mocked provider call aborts generate and fires cleanup', async () => {
    const marker_dir = await mkdtemp(join(tmpdir(), 'fascicle-engine-sigint-'))
    try {
      const { pid, exit } = await spawn_child(marker_dir)
  
      await wait_for_marker(join(marker_dir, 'ready'), 15_000)
      await new Promise((r) => setTimeout(r, 50))
      process.kill(pid, 'SIGINT')
  
      const result = await exit
      const exited_non_zero = result.code !== 0 || result.signal !== null
      expect(
        exited_non_zero,
        `child exit (code=${String(result.code)}, signal=${String(result.signal)}). stderr:\n${result.stderr}`,
      ).toBe(true)
  
      await stat(join(marker_dir, 'cleanup.first.ok'))
      await stat(join(marker_dir, 'cleanup.second.ok'))
  
      const engine_error_raw = await readFile(
        join(marker_dir, 'engine-error.json'),
        'utf8',
      )
      const engine_error = JSON.parse(engine_error_raw) as {
        is_engine_aborted_error: boolean
        name: string
      }
      expect(engine_error.is_engine_aborted_error).toBe(true)
      expect(engine_error.name).toBe('aborted_error')
  
      const exit_raw = await readFile(join(marker_dir, 'exit-reason.json'), 'utf8')
      const exit_info = JSON.parse(exit_raw) as {
        is_core_aborted_error: boolean
        is_engine_aborted_error: boolean
        name: string
      }
      expect(exit_info.name).toBe('aborted_error')
      expect(
        exit_info.is_engine_aborted_error || exit_info.is_core_aborted_error,
      ).toBe(true)
    } finally {
      await rm(marker_dir, { recursive: true, force: true })
    }
  }, 30_000)
})
