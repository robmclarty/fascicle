/**
 * Safe-spawn helper for `gh` and `git` subprocesses.
 *
 * Argv array, `shell: false`, env passed explicitly. Modeled on
 * `packages/engine/src/providers/claude_cli/spawn.ts:93-100`. Captures
 * stdout/stderr; errors include the failing argv and stderr for actionable
 * messages.
 *
 * Lives at `examples/pr-improve/src/github/` — outside the
 * `no-child-process-outside-claude-cli` rule's scope.
 */

import { spawn as node_spawn } from 'node:child_process'

export type SafeSpawnArgs = {
  readonly cmd: string
  readonly argv: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: string
}

export type SafeSpawnResult = {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export class SafeSpawnError extends Error {
  readonly cmd: string
  readonly argv: ReadonlyArray<string>
  readonly code: number | null
  readonly stderr: string

  constructor(cmd: string, argv: ReadonlyArray<string>, code: number | null, stderr: string) {
    const head = `${cmd} ${argv.join(' ')}`
    super(`${head} exited with code=${String(code)}: ${stderr.trim().slice(0, 500)}`)
    this.name = 'SafeSpawnError'
    this.cmd = cmd
    this.argv = argv
    this.code = code
    this.stderr = stderr
  }
}

export async function safe_spawn(args: SafeSpawnArgs): Promise<SafeSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = node_spawn(args.cmd, [...args.argv], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      cwd: args.cwd,
      env: args.env ?? process.env,
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      reject(err)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code: 0 })
      } else {
        reject(new SafeSpawnError(args.cmd, args.argv, code, stderr))
      }
    })

    if (args.stdin !== undefined) {
      child.stdin?.write(args.stdin)
    }
    child.stdin?.end()
  })
}
