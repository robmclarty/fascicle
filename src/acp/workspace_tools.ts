/**
 * workspace_tools: the tools a coding agent served over ACP needs, confined
 * to its session's workspace.
 *
 * They run in-process against the files on disk, never through the
 * client's `fs/*` methods, which Claude Agent stopped using and the ACP v2
 * draft drops. They're plain `Tool` values, so a flow can filter them (a
 * read-only critic takes the reads), set its own beside them, or wrap them.
 * Each one checks every path it's handed against the session's roots.
 */

import type { Tool } from '#engine'
import { list_files_tool } from './tools/list_files.js'
import { read_file_tool } from './tools/read_file.js'
import { search_tool } from './tools/search.js'
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

/**
 * The workspace tools for one session: `read_file`, `list_files`, and
 * `search`, each confined to the session's `cwd` and additional directories.
 */
export function workspace_tools(session: AcpSession, options: WorkspaceToolsOptions = {}): ReadonlyArray<Tool> {
  const ignore = options.ignore ?? IGNORE
  return [
    read_file_tool(session, options.read_limit_lines ?? READ_LIMIT_LINES),
    list_files_tool(session, ignore),
    search_tool(session, ignore, SEARCH_BUDGET_MS),
  ]
}
