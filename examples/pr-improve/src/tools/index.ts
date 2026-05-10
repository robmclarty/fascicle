/**
 * Public surface for the worktree-scoped builder tools (Phase C).
 *
 * `make_builder_tools(root)` returns the array passed to `model_call`'s
 * `tools` option. Wiring lives in PR B; this module is intentionally not
 * imported by `flow.ts` yet so PR A can ship the safety surface without
 * any behavioral change to the existing claude_cli demo.
 */

import type { Tool } from '@repo/fascicle'

import { make_edit_file } from './edit_file.js'
import { make_list_dir } from './list_dir.js'
import { make_read_file } from './read_file.js'
import { make_run_shell } from './run_shell.js'
import { make_write_file } from './write_file.js'

export { make_edit_file } from './edit_file.js'
export { make_list_dir } from './list_dir.js'
export { make_read_file } from './read_file.js'
export { make_run_shell, RunShellAllowlistError } from './run_shell.js'
export { make_write_file } from './write_file.js'
export { PathSafetyError, assert_not_symlink, resolve_within } from './path_safety.js'
export {
  MAX_FILE_BYTES,
  MAX_LIST_ENTRIES,
  MAX_SHELL_OUT_BYTES,
  SHELL_TIMEOUT_MS,
} from './limits.js'

export function make_builder_tools(worktree_root: string): ReadonlyArray<Tool> {
  return [
    make_list_dir(worktree_root),
    make_read_file(worktree_root),
    make_write_file(worktree_root),
    make_edit_file(worktree_root),
    make_run_shell(worktree_root),
  ]
}
