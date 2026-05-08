/**
 * Sandbox wrapper for the claude_cli adapter (spec §5.1, F30).
 *
 * Builds the `{ spawn_cmd, prefix_args }` pair for bwrap and greywall. When no
 * sandbox is configured, returns { spawn_cmd: binary, prefix_args: [] } — the
 * caller then concatenates prefix_args before the CLI argv.
 *
 * Both wrappers allow the binary to execute while restricting network reach
 * to the allowlist and write access to additional paths on top of the
 * sandbox's default-read-only filesystem.
 *
 * greywall 0.3+ removed the `--allow-host` and `--rw` flags; policy now
 * lives in a JSON settings file passed via `--settings <path>`. Schema is
 * documented in `greywall --help`:
 *
 *     {
 *       "network":    { "allowHosts": [...] },
 *       "filesystem": { "allowWrite": [...] }
 *     }
 *
 * `filesystem.allowWrite` is honored directly; `network.allowHosts` is
 * preserved for documentation/forward-compat (greywall ignores unknown
 * fields and host-level allowlisting is currently enforced at the
 * greyproxy layer).
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SandboxProviderConfig } from './types.js'

export type SandboxPlan = {
  readonly spawn_cmd: string
  readonly prefix_args: ReadonlyArray<string>
}

export function build_sandbox_plan(
  binary: string,
  sandbox: SandboxProviderConfig | undefined,
): SandboxPlan {
  if (sandbox === undefined) {
    return { spawn_cmd: binary, prefix_args: [] }
  }
  if (sandbox.kind === 'bwrap') {
    return { spawn_cmd: 'bwrap', prefix_args: build_bwrap_args(binary, sandbox) }
  }
  return { spawn_cmd: 'greywall', prefix_args: build_greywall_args(binary, sandbox) }
}

function build_bwrap_args(
  binary: string,
  sandbox: Extract<SandboxProviderConfig, { kind: 'bwrap' }>,
): ReadonlyArray<string> {
  const args: string[] = []
  args.push('--ro-bind', '/usr', '/usr')
  args.push('--ro-bind', '/bin', '/bin')
  args.push('--ro-bind', '/lib', '/lib')
  args.push('--ro-bind-try', '/lib64', '/lib64')
  args.push('--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf')
  args.push('--proc', '/proc')
  args.push('--dev', '/dev')
  args.push('--tmpfs', '/tmp')
  args.push('--unshare-user')
  args.push('--unshare-pid')
  args.push('--unshare-ipc')
  args.push('--unshare-uts')
  args.push('--unshare-cgroup-try')
  args.push('--die-with-parent')

  const allowlist = sandbox.network_allowlist ?? []
  if (allowlist.length > 0) {
    args.push('--share-net')
    for (const host of allowlist) {
      args.push('--setenv', 'CLAUDE_CLI_NET_ALLOW', host)
    }
  }

  const write_paths = sandbox.additional_write_paths ?? []
  for (const p of write_paths) {
    args.push('--bind', p, p)
  }

  args.push('--')
  args.push(binary)
  return args
}

function build_greywall_args(
  binary: string,
  sandbox: Extract<SandboxProviderConfig, { kind: 'greywall' }>,
): ReadonlyArray<string> {
  const settings_path = sandbox.settings_path ?? write_greywall_settings(sandbox)
  return ['--settings', settings_path, '--', binary]
}

function write_greywall_settings(
  sandbox: Extract<SandboxProviderConfig, { kind: 'greywall' }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), `fascicle-greywall-${process.pid}-`))
  const path = join(dir, 'greywall.json')
  const payload = {
    network: { allowHosts: [...(sandbox.network_allowlist ?? [])] },
    filesystem: { allowWrite: [...(sandbox.additional_write_paths ?? [])] },
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
  return path
}
