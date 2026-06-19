/**
 * `make_builder_tools(root)` returns the array passed to `model_call`'s
 * `tools` option. Wiring lives in PR B; this module is intentionally not
 * imported by `flow.ts` yet so PR A can ship the safety surface without
 * any behavioral change to the existing claude_cli demo.
 */

import type { Tool } from 'fascicle'

import { make_edit_file } from './edit_file.js'
import { make_list_dir } from './list_dir.js'
import { make_read_file } from './read_file.js'
import { make_run_shell } from './run_shell.js'
import { make_write_file } from './write_file.js'

export function make_builder_tools(worktree_root: string): ReadonlyArray<Tool> {
  return [
    make_list_dir(worktree_root),
    make_read_file(worktree_root),
    make_write_file(worktree_root),
    make_edit_file(worktree_root),
    make_run_shell(worktree_root),
  ]
}
