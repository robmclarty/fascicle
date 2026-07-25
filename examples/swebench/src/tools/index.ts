/**
 * The tool surface the model gets while solving a SWE-bench instance.
 *
 * Every tool closes over a per-case `Sandbox`, so all filesystem and shell
 * effects route through the same isolation boundary as the eventual eval. The
 * tools are intentionally small and POSIX-flavored, per the SWE-agent
 * "Agent-Computer Interface" rationale: a constrained, model-friendly command
 * surface beats a kitchen-sink toolset.
 *
 * Built per case rather than at module scope because the sandbox handle is per
 * case; that is the seam decoupling tool identity from sandbox identity.
 */

import type { Tool } from 'fascicle'

import type { Sandbox } from '../sandbox.js'
import { make_grep_files } from './grep_files.js'
import { make_list_files } from './list_files.js'
import { make_read_file } from './read_file.js'
import { make_run_command } from './run_command.js'
import { make_write_file } from './write_file.js'

export function make_sandbox_tools(sandbox: Sandbox): ReadonlyArray<Tool> {
  return [
    make_read_file(sandbox),
    make_write_file(sandbox),
    make_run_command(sandbox),
    make_list_files(sandbox),
    make_grep_files(sandbox),
  ]
}
