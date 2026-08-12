/**
 * The ai_sdk turn seam is loaded lazily (plan step 6).
 *
 * `generate.ts` reaches providers/ai_sdk/invoke.ts, the engine's only `ai`
 * importer, through `await import(...)`, so `ai` is on the module graph of an
 * ai_sdk call and nothing else. This spawns a child process in which the `ai`
 * specifier does not resolve at all and drives a native-transport generate end
 * to end: reinstate the static import and the child fails to link, long before
 * the call runs.
 *
 * A child process rather than a vitest module mock because the claim is about
 * resolution, not about what a module returns once resolved.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const child_script = join(here, 'child-harness.ts')
const register_script = join(here, 'register-ts-resolver.mjs')

type ChildExit = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

async function run_child(): Promise<ChildExit> {
  const child = spawn(process.execPath, ['--import', register_script, child_script], {
    cwd: here,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  return new Promise<ChildExit>((resolve) => {
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr })
    })
  })
}

describe('ai_sdk seam laziness', () => {
  it('runs a native-transport generate with the `ai` peer unresolvable', async () => {
    const result = await run_child()
    expect(
      result.code,
      `child exit (signal=${String(result.signal)}). stderr:\n${result.stderr}`,
    ).toBe(0)
    expect(result.stdout).toBe('native ok')
  }, 30_000)
})
