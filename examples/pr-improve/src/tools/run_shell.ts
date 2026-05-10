/**
 * run_shell: argv-allowlisted subprocess execution scoped to the worktree.
 *
 * The model passes argv as an array; argv[0] must be in the command
 * allowlist. For git, argv[1] (the subcommand) must additionally be in the
 * git-subcommand allowlist. shell: false always — no string concatenation,
 * no glob expansion, no command injection surface.
 *
 * Output is capped per stream at MAX_SHELL_OUT_BYTES with a truncation
 * marker; runtime is capped at SHELL_TIMEOUT_MS via AbortController.
 *
 * The pnpm allowlist entry intentionally accepts any subcommand to match
 * the original SPEC; tightening (e.g. limit to test/check/exec) is a
 * follow-up tracked in SPEC.md.
 */

import { spawn } from 'node:child_process'
import { z } from 'zod'

import type { Tool, ToolExecContext } from '@repo/fascicle'

import { MAX_SHELL_OUT_BYTES, SHELL_TIMEOUT_MS } from './limits.js'

const COMMAND_ALLOWLIST: ReadonlyMap<string, ReadonlyArray<string> | 'any'> = new Map<
  string,
  ReadonlyArray<string> | 'any'
>([
  ['pnpm', 'any'],
  ['git', ['status', 'diff', 'add', 'commit']],
])

const TRUNCATION_MARKER = '\n[truncated by run_shell at byte limit]\n'

export const run_shell_input = z.object({
  argv: z.array(z.string().min(1)).min(1),
})

type RunShellInput = z.infer<typeof run_shell_input>

export type RunShellOutput = {
  readonly argv: ReadonlyArray<string>
  readonly stdout: string
  readonly stderr: string
  readonly code: number
  readonly truncated: boolean
  readonly timed_out: boolean
}

export class RunShellAllowlistError extends Error {
  override readonly name = 'RunShellAllowlistError'
}

export function make_run_shell(root: string): Tool {
  return {
    name: 'run_shell',
    description:
      'Run an allowlisted command in the PR worktree. argv must be an array; ' +
      'shell features (pipes, redirection, expansion) are not available. ' +
      'Allowed: pnpm <any>, git status|diff|add|commit. Output capped at ' +
      String(MAX_SHELL_OUT_BYTES) +
      ' bytes per stream; runtime capped at ' +
      String(SHELL_TIMEOUT_MS) +
      ' ms.',
    input_schema: run_shell_input,
    execute: (raw, ctx) => execute_run_shell(run_shell_input.parse(raw), ctx, root),
  }
}

async function execute_run_shell(
  input: RunShellInput,
  ctx: ToolExecContext,
  root: string,
): Promise<RunShellOutput> {
  assert_allowed(input.argv)
  return new Promise<RunShellOutput>((resolve, reject) => {
    const cmd = input.argv[0]
    const rest = input.argv.slice(1)
    if (cmd === undefined) {
      reject(new RunShellAllowlistError('argv[0] is missing'))
      return
    }

    const controller = new AbortController()
    const caller_abort = ctx.abort
    let caller_aborted = false
    const on_caller_abort = (): void => {
      caller_aborted = true
      controller.abort(caller_abort.reason)
    }
    if (caller_abort.aborted) {
      caller_aborted = true
      controller.abort(caller_abort.reason)
    } else {
      caller_abort.addEventListener('abort', on_caller_abort, { once: true })
    }

    let timed_out = false
    const timer = setTimeout(() => {
      timed_out = true
      controller.abort(new Error('run_shell timeout'))
    }, SHELL_TIMEOUT_MS)
    timer.unref?.()

    const stdout_chunks: Buffer[] = []
    const stderr_chunks: Buffer[] = []
    let stdout_bytes = 0
    let stderr_bytes = 0
    let stdout_truncated = false
    let stderr_truncated = false

    const child = spawn(cmd, [...rest], {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      signal: controller.signal,
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = MAX_SHELL_OUT_BYTES - stdout_bytes
      if (remaining <= 0) {
        stdout_truncated = true
        return
      }
      if (chunk.byteLength <= remaining) {
        stdout_chunks.push(chunk)
        stdout_bytes += chunk.byteLength
      } else {
        stdout_chunks.push(chunk.subarray(0, remaining))
        stdout_bytes += remaining
        stdout_truncated = true
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = MAX_SHELL_OUT_BYTES - stderr_bytes
      if (remaining <= 0) {
        stderr_truncated = true
        return
      }
      if (chunk.byteLength <= remaining) {
        stderr_chunks.push(chunk)
        stderr_bytes += chunk.byteLength
      } else {
        stderr_chunks.push(chunk.subarray(0, remaining))
        stderr_bytes += remaining
        stderr_truncated = true
      }
    })

    child.on('error', (err) => {
      // AbortError fires when controller.abort() kills the process; close
      // will also fire in that case, so defer settlement to close.
      // Only reject here for spawn failures where close will not fire.
      const is_abort =
        (err as { code?: unknown }).code === 'ABORT_ERR' ||
        (err as { name?: unknown }).name === 'AbortError'
      if (!is_abort) {
        clearTimeout(timer)
        caller_abort.removeEventListener('abort', on_caller_abort)
        reject(err)
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      caller_abort.removeEventListener('abort', on_caller_abort)
      if (caller_aborted && !timed_out) {
        const reason = caller_abort.reason
        reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')))
        return
      }
      const stdout = Buffer.concat(stdout_chunks).toString('utf8')
      const stderr = Buffer.concat(stderr_chunks).toString('utf8')
      const final_stdout = stdout_truncated ? stdout + TRUNCATION_MARKER : stdout
      const final_stderr = stderr_truncated ? stderr + TRUNCATION_MARKER : stderr
      resolve({
        argv: input.argv,
        stdout: final_stdout,
        stderr: final_stderr,
        code: code ?? -1,
        truncated: stdout_truncated || stderr_truncated,
        timed_out,
      })
    })
  })
}

function assert_allowed(argv: ReadonlyArray<string>): void {
  const cmd = argv[0]
  if (cmd === undefined) {
    throw new RunShellAllowlistError('argv must be non-empty')
  }
  const allowed = COMMAND_ALLOWLIST.get(cmd)
  if (allowed === undefined) {
    const allowed_cmds = [...COMMAND_ALLOWLIST.keys()].join(', ')
    throw new RunShellAllowlistError(`command not allowed: ${cmd} (allowed: ${allowed_cmds})`)
  }
  if (allowed === 'any') return
  const sub = argv[1]
  if (sub === undefined || !allowed.includes(sub)) {
    throw new RunShellAllowlistError(
      `${cmd} subcommand not allowed: ${sub ?? '(missing)'} (allowed: ${allowed.join(', ')})`,
    )
  }
}
