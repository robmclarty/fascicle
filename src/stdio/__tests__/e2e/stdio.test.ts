import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StdioFailure } from '../../execute_stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const child_script = join(here, 'child-harness.ts')
const register_script = join(here, '..', '..', '..', '..', 'test', 'support', 'register-ts-resolver.mjs')

type ChildResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function spawn_agent(
  stdin: string | null,
  env: Record<string, string> = {},
): { pid: number; exit: Promise<ChildResult> } {
  const child = spawn(process.execPath, ['--import', register_script, child_script], {
    cwd: here,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (child.pid === undefined) throw new Error('child failed to spawn')

  if (stdin !== null) child.stdin.write(stdin)
  child.stdin.end()

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const exit = new Promise<ChildResult>((resolve) => {
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr })
    })
  })
  return { pid: child.pid, exit }
}

function stderr_lines(stderr: string): string[] {
  return stderr.split('\n').filter((l) => l.length > 0)
}

function last_failure(stderr: string): StdioFailure {
  const lines = stderr_lines(stderr)
  const last = lines[lines.length - 1]
  if (last === undefined) throw new Error('no stderr lines')
  return JSON.parse(last) as StdioFailure
}

async function wait_for_marker(path: string, timeout_ms: number): Promise<void> {
  const deadline = Date.now() + timeout_ms
  for (;;) {
    try {
      await stat(path)
      return
    } catch {
      if (Date.now() >= deadline) throw new Error(`marker never appeared at ${path}`)
      await new Promise((resolve) => {
        setTimeout(resolve, 25)
      })
    }
  }
}

describe('stdio agent contract (spawned)', () => {
  it('exit 0: exactly one JSON document on stdout, JSONL trajectory on stderr', async () => {
    const result = await spawn_agent(JSON.stringify({ topic: 'tests' })).exit

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ headline: 'about tests' })
    expect(result.stdout.trim().split('\n')).toHaveLength(1)

    const lines = stderr_lines(result.stderr)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  }, 30_000)

  it('exit 2 on garbage stdin: empty stdout, last stderr line is a StdioFailure', async () => {
    const result = await spawn_agent('not json').exit

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(last_failure(result.stderr).stage).toBe('parse')
  }, 30_000)

  it('exit 2 on schema-invalid stdin', async () => {
    const result = await spawn_agent(JSON.stringify({ topic: 42 })).exit

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(last_failure(result.stderr).stage).toBe('validate_input')
  }, 30_000)

  it('exit 1 when the flow throws: last stderr line carries the error', async () => {
    const result = await spawn_agent(JSON.stringify({ topic: 'tests' }), { MODE: 'throw' }).exit

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    const failure = last_failure(result.stderr)
    expect(failure.stage).toBe('run')
    expect(failure.error).toBe('kaboom')
  }, 30_000)

  it('exit 1 on a forwarded SIGINT mid-run', async () => {
    const marker_dir = await mkdtemp(join(tmpdir(), 'fascicle-stdio-'))
    try {
      const { pid, exit } = spawn_agent(JSON.stringify({ topic: 'tests' }), {
        MODE: 'slow',
        MARKER_DIR: marker_dir,
      })

      await wait_for_marker(join(marker_dir, 'ready'), 45_000)
      process.kill(pid, 'SIGINT')

      const result = await exit
      expect(result.code, `stderr:\n${result.stderr}`).toBe(1)
      expect(result.stdout).toBe('')
      const failure = last_failure(result.stderr)
      expect(failure.stage).toBe('run')
      expect(failure.error).toMatch(/SIGINT/)
    } finally {
      await rm(marker_dir, { recursive: true, force: true })
    }
  }, 75_000)
})
