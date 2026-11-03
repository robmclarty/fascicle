/**
 * Claude Code version gate for the `claude_code` sandbox.
 *
 * The sandbox's settings keys arrived over several Claude Code releases, and
 * the CLI drops a settings key it doesn't know without failing, so a run on
 * an older CLI would go ahead with part of its policy missing. The gate asks
 * the binary for its version before the first sandboxed call on each `PATH`,
 * and refuses a CLI older than `CLAUDE_CODE_SANDBOX_MIN_VERSION`.
 */

import { claude_cli_error } from '../../errors.js'
import { CLAUDE_CODE_SANDBOX_MIN_VERSION } from './constants.js'
import type { SpawnRuntime } from './spawn.js'

type CliVersion = readonly [number, number, number]

export type CliVersionGateInit = {
  readonly cmd: string
  readonly startup_timeout_ms: number
  readonly stall_timeout_ms: number
}

export type CliVersionGate = {
  readonly ensure: (env: Record<string, string>, abort: AbortSignal) => Promise<void>
}

/**
 * Read the `major.minor.patch` that `claude --version` prints first, as in
 * `2.1.316 (Claude Code)`. Returns `undefined` for anything else.
 */
export function parse_cli_version(text: string): CliVersion | undefined {
  const match = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Whether `found` is the release `floor` names or a later one, comparing
 * major, then minor, then patch.
 */
export function version_at_least(found: CliVersion, floor: CliVersion): boolean {
  const [major, minor, patch] = found
  const [floor_major, floor_minor, floor_patch] = floor
  if (major !== floor_major) return major > floor_major
  if (minor !== floor_minor) return minor > floor_minor
  return patch >= floor_patch
}

/**
 * Run `<cmd> --version` once and throw `sandbox_unavailable` unless it
 * reports at least the floor.
 *
 * Output that doesn't lead with a version, or a nonzero exit, fails the same
 * way, since the gate can't vouch for a CLI it can't read.
 */
async function check_cli_version(
  spawn_runtime: SpawnRuntime,
  init: CliVersionGateInit,
  env: Record<string, string>,
  abort: AbortSignal,
): Promise<void> {
  const session = await spawn_runtime.spawn_cli({ ...init, argv: ['--version'], env, stdin: '', abort })
  const lines: string[] = []
  for await (const line of session.stdout_lines) lines.push(line)
  const outcome = await session.wait_close()
  const output = lines.join('\n').trim()
  const found = outcome.code === 0 ? parse_cli_version(output) : undefined
  const floor = CLAUDE_CODE_SANDBOX_MIN_VERSION.join('.')
  if (found === undefined) {
    throw new claude_cli_error(
      'sandbox_unavailable',
      `couldn't read a Claude Code version from '${init.cmd} --version' (exit ${String(outcome.code)}, output '${output.slice(0, 120)}'): the claude_code sandbox needs Claude Code ${floor} or later, so point providers.claude_cli.binary at a claude that prints one`,
      { stderr_snippet: outcome.stderr.slice(0, 512) },
    )
  }
  if (!version_at_least(found, CLAUDE_CODE_SANDBOX_MIN_VERSION)) {
    throw new claude_cli_error(
      'sandbox_unavailable',
      `Claude Code ${found.join('.')} is older than ${floor}, the first release that honors every setting the claude_code sandbox needs: run claude update, or point providers.claude_cli.binary at a newer claude`,
    )
  }
}

/**
 * Build the per-adapter gate. `ensure` checks the CLI the first time it sees
 * a call's `PATH`, because a bare binary name resolves against that `PATH`
 * and a call can pass its own, so a pass for one `PATH` says nothing about
 * the binary that another finds. It remembers only passes, so a CLI that's
 * updated after a failure passes on the next call.
 */
export function create_cli_version_gate(
  spawn_runtime: SpawnRuntime,
  init: CliVersionGateInit,
): CliVersionGate {
  const passed = new Set<string>()
  return {
    ensure: async (env, abort) => {
      const path = env['PATH'] ?? ''
      if (passed.has(path)) return
      await check_cli_version(spawn_runtime, init, env, abort)
      passed.add(path)
    },
  }
}
