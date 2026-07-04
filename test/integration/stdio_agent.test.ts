/**
 * Spawns examples/stdio_agent.ts exactly the way a user (or a parent harness)
 * would (`tsx examples/stdio_agent.ts` with JSON piped to stdin) and asserts
 * the full envelope: exit code, single JSON document on stdout, machine-
 * readable failure as the last stderr line.
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo_root = join(fileURLToPath(import.meta.url), '..', '..', '..')
const tsx_bin = join(repo_root, 'node_modules', '.bin', 'tsx')
const agent_script = join(repo_root, 'examples', 'stdio_agent.ts')

type AgentResult = { code: number | null; stdout: string; stderr: string }

function spawn_example(stdin: string): Promise<AgentResult> {
  const child = spawn(tsx_bin, [agent_script], {
    cwd: repo_root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.write(stdin)
  child.stdin.end()

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  return new Promise((resolve) => {
    child.on('close', (code) => {
      resolve({ code, stdout, stderr })
    })
  })
}

describe('stdio_agent example under a parent', () => {
  it('valid input: exit 0 and exactly one JSON document on stdout', async () => {
    const result = await spawn_example(JSON.stringify({ topic: 'flaky tests' }))

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0)
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.stdout)).toEqual({
      headline: 'flaky tests: what actually changed',
      candidates: ['flaky tests: what actually changed', 'notes toward flaky tests'],
    })
  }, 60_000)

  it('garbage input: exit 2, empty stdout, StdioFailure as the last stderr line', async () => {
    const result = await spawn_example('not json')

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    const lines = result.stderr.split('\n').filter((l) => l.length > 0)
    const failure = JSON.parse(lines[lines.length - 1] ?? '') as { stage?: string }
    expect(failure.stage).toBe('parse')
  }, 60_000)
})
