/**
 * Argv builder for the claude CLI invocation (spec §6.1).
 *
 * Every option value is a separate argv element; option names are never
 * string-interpolated with values (constraints §3 subprocess discipline #8).
 * The returned array is a readonly frozen copy; mutation would indicate a
 * caller bug.
 */

import type { ClaudeCliCallOptions, ClaudeCliProviderConfig } from './types.js'
import { DEFAULT_SETTING_SOURCES } from './constants.js'

export type BuildArgvInput = {
  readonly model_id: string
  readonly provider_config: ClaudeCliProviderConfig
  readonly call_opts: ClaudeCliCallOptions
  readonly merged_allowed_tools: ReadonlyArray<string>
  readonly merged_system: string
  readonly compiled_schema?: string
}

export function build_cli_argv(input: BuildArgvInput): ReadonlyArray<string> {
  const args: string[] = []
  args.push('-p')
  args.push('--output-format', 'stream-json')
  args.push('--model', input.model_id)
  args.push('--verbose')

  const setting_sources =
    input.provider_config.setting_sources ?? DEFAULT_SETTING_SOURCES
  args.push('--setting-sources', setting_sources.join(','))

  for (const tool of input.merged_allowed_tools) {
    args.push('--allowedTools', tool)
  }

  if (typeof input.call_opts.session_id === 'string' && input.call_opts.session_id.length > 0) {
    args.push('--resume', input.call_opts.session_id)
  }

  if (input.call_opts.agents !== undefined) {
    args.push('--agents', JSON.stringify(input.call_opts.agents))
  }

  const plugin_dirs = input.provider_config.plugin_dirs ?? []
  for (const dir of plugin_dirs) {
    args.push('--plugin-dir', dir)
  }

  if (typeof input.compiled_schema === 'string' && input.compiled_schema.length > 0) {
    args.push('--json-schema', input.compiled_schema)
  }

  if (input.merged_system.length > 0) {
    args.push('--append-system-prompt', input.merged_system)
  }

  const extra_args = input.call_opts.extra_args ?? []
  for (const s of extra_args) {
    args.push(s)
  }

  return Object.freeze(args)
}

export function merge_system(
  opts_system: string | undefined,
  append: string | undefined,
): string {
  const parts: string[] = []
  if (typeof opts_system === 'string' && opts_system.length > 0) parts.push(opts_system)
  if (typeof append === 'string' && append.length > 0) parts.push(append)
  return parts.join('\n\n')
}

export function merge_allowed_tools(
  call_allowlist: ReadonlyArray<string> | undefined,
  tool_names: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>()
  const merged: string[] = []
  const push_unique = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    merged.push(name)
  }
  if (call_allowlist !== undefined) {
    for (const t of call_allowlist) push_unique(t)
  }
  for (const n of tool_names) push_unique(n)
  return merged
}
