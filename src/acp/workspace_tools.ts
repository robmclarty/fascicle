/**
 * workspace_tools: the tools a coding agent served over ACP needs, confined
 * to its session's workspace.
 *
 * They run in-process against the files on disk and in a shell of their
 * own, never through the client's `fs/*` or `terminal/*` methods, which
 * Claude Agent stopped using and the ACP v2 draft drops. They're plain
 * `Tool` values, so a flow can filter them (a read-only critic takes the
 * reads), set its own beside them, or wrap them. Each file tool checks every
 * path it's handed against the session's roots; a command starts in `cwd`
 * and reaches whatever the user can.
 */

import type { Tool } from '#engine'
import { edit_file_tool } from './tools/edit_file.js'
import { list_files_tool } from './tools/list_files.js'
import { read_file_tool } from './tools/read_file.js'
import { run_command_tool } from './tools/run_command.js'
import { search_tool } from './tools/search.js'
import { write_file_tool } from './tools/write_file.js'
import type { AcpSession, WorkspaceToolsOptions } from './types.js'

/** The most lines one `read_file` call returns unless the options say otherwise. */
const READ_LIMIT_LINES = 2000

/** The names `list_files` and `search` skip unless the options say otherwise. */
const IGNORE: ReadonlyArray<string> = ['.git', 'node_modules']

/**
 * How long one `search` may run, its worker's start included, before it's
 * stopped. Long enough to read a large repository, and short enough that a
 * pattern stuck backtracking comes back as an error the model can act on.
 */
const SEARCH_BUDGET_MS = 30_000

/** How long one `run_command` call may run unless the options or the call say otherwise. */
const COMMAND_TIMEOUT_MS = 120_000

/** The most output one `run_command` call returns unless the options say otherwise. */
const OUTPUT_LIMIT_BYTES = 32_000

/**
 * The workspace tools for one session: the reads (`read_file`, `list_files`,
 * and `search`), then the writes (`write_file` and `edit_file`), each
 * confined to the session's `cwd` and additional directories, then
 * `run_command`.
 */
export function workspace_tools(session: AcpSession, options: WorkspaceToolsOptions = {}): ReadonlyArray<Tool> {
  const ignore = options.ignore ?? IGNORE
  return [
    read_file_tool(session, options.read_limit_lines ?? READ_LIMIT_LINES),
    list_files_tool(session, ignore),
    search_tool(session, ignore, SEARCH_BUDGET_MS),
    write_file_tool(session),
    edit_file_tool(session),
    run_command_tool(session, {
      timeout_ms: options.command_timeout_ms ?? COMMAND_TIMEOUT_MS,
      output_limit_bytes: options.output_limit_bytes ?? OUTPUT_LIMIT_BYTES,
      env: options.command_env,
    }),
  ]
}
