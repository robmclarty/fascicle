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
 *
 * The writes and `run_command` ask for approval when the session's mode
 * says to, and the reads never do.
 *
 * A flow or an MCP server can hand a model a tool of its own under one of
 * these names, and a name is all the engine tells the approval and the
 * cards. So each session keeps what it built: the names, which pick the
 * cards it draws, and every validated input that its gated tools were
 * asked about, which is how the approval knows its own calls. The engine
 * hands `needs_approval` and the approval handler the same input object,
 * so a same-named tool's call never passes for one of these.
 */

import type { Tool } from '#engine'
import { is_record } from '#schema'
import { asks_before } from './modes.js'
import type { GatedAction } from './modes.js'
import { edit_file_tool } from './tools/edit_file.js'
import { list_files_tool } from './tools/list_files.js'
import { read_file_tool } from './tools/read_file.js'
import { run_command_tool } from './tools/run_command.js'
import { search_tool } from './tools/search.js'
import { write_file_tool } from './tools/write_file.js'
import type { AcpSession, WorkspaceToolsOptions } from './types.js'

/** The most lines one `read_file` call returns unless the options say otherwise. */
const READ_LIMIT_LINES = 2000

/** The most paths one `list_files` call returns, so a very large repository's listing can't fill the context. */
const LIST_LIMIT = 1000

/** The names `list_files` and `search` skip unless the options say otherwise. */
const IGNORE: ReadonlyArray<string> = ['.git', 'node_modules']

/** How long one `search` may run unless the options say otherwise. */
const SEARCH_TIMEOUT_MS = 30_000

/** How long one `run_command` call may run unless the options or the call say otherwise. */
const COMMAND_TIMEOUT_MS = 120_000

/** The most output one `run_command` call returns unless the options say otherwise. */
const OUTPUT_LIMIT_BYTES = 32_000

/**
 * The names each session's `workspace_tools` built. The set takes
 * `undefined` too, so a card whose opening the mapper never saw simply
 * finds nothing.
 */
const built = new WeakMap<AcpSession, ReadonlySet<string | undefined>>()

/** The validated inputs each session's gated workspace tools were asked about. */
const asked = new WeakMap<AcpSession, WeakSet<object>>()

/**
 * The inputs the session's gated workspace tools were asked about, made
 * empty the first time it's asked for.
 */
function asked_of(session: AcpSession): WeakSet<object> {
  const inputs = asked.get(session) ?? new WeakSet<object>()
  asked.set(session, inputs)
  return inputs
}

/**
 * Whether the session's `workspace_tools` built a tool named `name`, so its
 * calls take the card that tool's presentation gives it.
 */
export function is_workspace_tool(session: AcpSession, name: string | undefined): boolean {
  return built.get(session)?.has(name) === true
}

/**
 * Whether one of the session's gated workspace tools was asked about this
 * very input, which makes the call one of theirs rather than a call to a
 * tool that only shares a name with one.
 */
export function is_workspace_call(session: AcpSession, input: unknown): boolean {
  return is_record(input) && asked.get(session)?.has(input) === true
}

/**
 * `tool`, asking for approval before each call when the session's mode asks
 * before `action`, and marking the input it was asked about as one of the
 * session's own. The mode is read at each call, not once, so a switch the
 * client makes mid-turn holds from the next call on.
 */
function gated(tool: Tool, session: AcpSession, action: GatedAction): Tool {
  return {
    ...tool,
    needs_approval: (input) => {
      if (is_record(input)) asked_of(session).add(input)
      return asks_before(session.mode(), action)
    },
  }
}

/**
 * The workspace tools for one session: the reads (`read_file`, `list_files`,
 * and `search`), then the writes (`write_file` and `edit_file`), each
 * confined to the session's `cwd` and additional directories, then
 * `run_command`. The writes and the command ask before they run as the
 * session's mode says. From the first call on, the six names are the
 * workspace tools' within the session.
 */
export function workspace_tools(session: AcpSession, options: WorkspaceToolsOptions = {}): ReadonlyArray<Tool> {
  const ignore = options.ignore ?? IGNORE
  const tools = [
    read_file_tool(session, options.read_limit_lines ?? READ_LIMIT_LINES),
    list_files_tool(session, ignore, LIST_LIMIT),
    search_tool(session, ignore, options.search_timeout_ms ?? SEARCH_TIMEOUT_MS),
    gated(write_file_tool(session), session, 'edit'),
    gated(edit_file_tool(session), session, 'edit'),
    gated(
      run_command_tool(session, {
        timeout_ms: options.command_timeout_ms ?? COMMAND_TIMEOUT_MS,
        output_limit_bytes: options.output_limit_bytes ?? OUTPUT_LIMIT_BYTES,
        env: options.command_env,
      }),
      session,
      'command',
    ),
  ]
  built.set(session, new Set(tools.map((tool) => tool.name)))
  return tools
}
