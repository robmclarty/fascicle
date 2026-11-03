/**
 * Claude Code's own sandbox for the claude_cli adapter.
 *
 * A `claude_code` sandbox needs no wrapper around the binary. The CLI
 * enforces it from the JSON that `build_cli_argv` passes inline with
 * `--settings`, and this module renders that JSON and checks the policy
 * before any run.
 *
 * The sandbox confines Bash and nothing else: Claude's file tools, hooks,
 * and MCP servers run in the unsandboxed CLI process. So the policy pairs
 * the sandbox with the permission keys that keep the file tools inside the
 * working directories, and turns hooks off.
 */

import { engine_config_error } from '../../errors.js'
import type { ClaudeCliProviderConfig, SandboxProviderConfig } from './types.js'

type ClaudeCodeSandbox = Extract<SandboxProviderConfig, { kind: 'claude_code' }>

/**
 * Drop the trailing slashes from a path that's longer than its prefix, so
 * `~/.ssh/` and `~/.ssh` render the same rules.
 */
function trim_path(path: string): string {
  return path.length > 2 ? path.replace(/\/+$/, '') : path
}

/**
 * The permission rules that keep the file tools off one denied path and
 * everything under it. A permission rule spells an absolute path with a
 * leading `//`, where the sandbox's own lists take a single `/`.
 */
function read_deny_rules(path: string): ReadonlyArray<string> {
  const rule_path = path.startsWith('~/') ? path : `/${path}`
  return [`Read(${rule_path})`, `Read(${rule_path}/**)`]
}

/**
 * Throw `engine_config_error` when a `claude_code` sandbox names a path that
 * isn't absolute or under `~/`.
 *
 * Claude Code resolves a relative path against a different directory in
 * each of its lists, and against none that's documented when the settings
 * arrive inline, so the policy takes only paths that read the same
 * everywhere. Runs at adapter construction, before anything spawns.
 */
export function validate_sandbox_config(config: ClaudeCliProviderConfig): void {
  const sandbox = config.sandbox
  if (sandbox?.kind !== 'claude_code') return
  const paths = [
    ...(sandbox.additional_write_paths ?? []),
    ...(sandbox.additional_read_paths ?? []),
    ...(sandbox.deny_read_paths ?? []),
  ]
  const relative = paths.filter((p) => !p.startsWith('/') && !p.startsWith('~/'))
  if (relative.length > 0) {
    throw new engine_config_error(
      `providers.claude_cli.sandbox has relative paths (${relative.join(', ')}): make each one absolute or start it with ~/, since Claude Code resolves a relative path differently in each list`,
      'claude_cli',
    )
  }
}

/**
 * Throw `engine_config_error` when a call's `extra_args` carries its own
 * `--settings` under a `claude_code` sandbox.
 *
 * The sandbox travels as `--settings`, and a second one would replace or
 * merge with it in ways the CLI doesn't document, so the call is refused
 * instead of running with a policy nobody wrote.
 */
export function validate_sandbox_extra_args(
  sandbox: SandboxProviderConfig | undefined,
  extra_args: ReadonlyArray<string> | undefined,
): void {
  if (sandbox?.kind !== 'claude_code') return
  const has_settings = (extra_args ?? []).some(
    (arg) => arg === '--settings' || arg.startsWith('--settings='),
  )
  if (has_settings) {
    throw new engine_config_error(
      "extra_args can't carry --settings under a claude_code sandbox, because the sandbox is passed as --settings: drop it from extra_args, or leave the sandbox off this provider",
      'claude_cli',
    )
  }
}

/**
 * Render a `claude_code` sandbox as the JSON that the CLI takes inline with
 * `--settings`.
 *
 * - `failIfUnavailable` makes the CLI exit at startup when its sandbox
 *   can't start, instead of running Bash unconfined.
 * - `allowUnsandboxedCommands: false` arriving through `--settings` makes
 *   the sandbox admin-required, so a repo's own settings can't loosen it.
 * - `autoAllowBashIfSandboxed: false` leaves the call's allowlist deciding
 *   whether Bash runs at all, rather than the sandbox approving it.
 * - `strictAllowlist` refuses a host off the list rather than asking for it.
 * - The two `permissions` blocks hold the file tools inside the working
 *   directories in every permission mode, and the Read deny rules keep them
 *   off the denied paths too.
 * - `disableAllHooks` turns hooks off, because they run outside the sandbox
 *   and `-p` runs a project's hooks without asking.
 */
export function render_sandbox_settings(sandbox: ClaudeCodeSandbox): string {
  const deny_paths = (sandbox.deny_read_paths ?? []).map(trim_path)
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: {
        allowedDomains: [...(sandbox.network_allowlist ?? [])],
        strictAllowlist: true,
      },
      filesystem: {
        allowWrite: (sandbox.additional_write_paths ?? []).map(trim_path),
        allowRead: (sandbox.additional_read_paths ?? []).map(trim_path),
        denyRead: deny_paths,
      },
    },
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      deny: deny_paths.flatMap(read_deny_rules),
    },
    disableAllHooks: true,
  })
}
