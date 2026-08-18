/**
 * The `ai` peer is named in the missing-peer message (plan step 7).
 *
 * generate.ts reaches providers/ai_sdk/invoke.ts through load_optional_peer
 * (plan step 6's lazy seam). When `ai` itself does not resolve, that failure
 * must surface as the same `load_optional_peer` message every other optional
 * peer produces, naming `ai` and its install command, rather than a raw
 * module-resolution error naming the local invoke.ts path.
 *
 * A child process rather than a vitest module mock because the claim is
 * about resolution, not about what a module returns once resolved (same
 * rationale as missing_ai_peer.test.ts).
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const child_script = join(here, 'ai-sdk-child-harness.ts')
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

describe('ai_sdk transport missing-peer message', () => {
  it('names `ai` and the install command when the peer cannot resolve', async () => {
    const result = await run_child()
    expect(
      result.code,
      `child exit (signal=${String(result.signal)}). stderr:\n${result.stderr}`,
    ).toBe(0)
    expect(result.stdout).toContain("missing peer dependency 'ai'")
    expect(result.stdout).toContain('pnpm add ai')
    expect(result.stdout).toContain('npm install ai')
  }, 30_000)
})
