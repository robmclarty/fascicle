/**
 * mcp_servers: the MCP servers a client sends with a session, connected
 * for the session's flow.
 *
 * Zed sends the MCP servers its user configured with every session. An
 * agent whose config sets `mcp_servers` connects to each one through
 * `mcp_client` from fascicle/mcp and hands their tools to the flow builder.
 * A server that can't be reached is left out with a warning on stderr
 * rather than failing the session, so one broken entry in the editor's
 * settings can't stop every thread, and the warning is kept for a client
 * that shows notices. A server's `env` and `headers` values are
 * credentials, so a warning carries the server's name and its error with
 * any of those values cut out, and nothing else of the server.
 *
 * Each tool is named `mcp__<server>__<tool>`, the form Claude Code uses, so
 * two servers' tools don't collide and none takes a workspace tool's name.
 * A provider takes a tool name of 64 characters at most, and the engine
 * refuses two tools under one name, so a name that runs longer, or that
 * another tool already took once the server's name was cleaned up, is cut
 * and ends in a hash of its server and tool. The tool still calls its
 * server under the name the server gave it.
 *
 * An MCP tool can do anything its server can, so each one asks before it
 * runs whenever the session's mode asks before a command. The approval
 * knows these calls the way it knows the workspace tools', by the input
 * their `needs_approval` was asked about, so a flow's own tool that copies
 * one's name doesn't pass for it.
 *
 * The connections last as long as the session, and close when the client
 * closes the session or the connection.
 */

import { createHash } from 'node:crypto'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { Tool } from '#engine'
import { mcp_client } from '#mcp'
import type { McpClientConfig, McpClientHandle } from '#mcp'
import { is_record } from '#schema'
import { asks_before } from './modes.js'
import type { AcpSession } from './types.js'

/**
 * The MCP transports the agent tells a client it speaks beside stdio, which
 * every agent takes.
 */
export const MCP_CAPABILITIES = { http: true } as const

/** What went wrong with one MCP server, in the words a client shows the user. */
export type McpWarning = {
  readonly title: string
  readonly description: string
}

/**
 * A session's MCP servers, connected: every tool they offer, the way to
 * close them all, and a warning for each server that was left out.
 */
export type McpConnections = {
  readonly tools: ReadonlyArray<Tool>
  readonly close: () => Promise<void>
  readonly warnings: ReadonlyArray<McpWarning>
}

/** The connections of a session with no MCP servers. */
export const NO_MCP: McpConnections = { tools: [], close: async () => {}, warnings: [] }

/** The longest tool name a provider takes. */
const NAME_LIMIT = 64

/**
 * The shortest `env` or `headers` value that's cut out of a warning. A
 * shorter one, such as `1` or `true`, is a setting, and cutting it would
 * shred the message it happens to appear in.
 */
const SECRET_LENGTH = 8

/** How many characters of a hash end a shortened name. */
const HASH_LENGTH = 8

/** Who the agent says it is to each server. */
type McpIdentity = { readonly name: string; readonly version: string }

/** The validated inputs each session's MCP tools were asked about. */
const asked = new WeakMap<AcpSession, WeakSet<object>>()

/**
 * Say on stderr what went wrong with a session's MCP servers, since the
 * session carries on without what failed.
 */
function warn(message: string): void {
  process.stderr.write(`fascicle/acp: ${message}\n`)
}

/**
 * A list of names and values as the record a transport takes.
 */
function record_of(entries: ReadonlyArray<{ readonly name: string; readonly value: string }>): Record<string, string> {
  return Object.fromEntries(entries.map(({ name, value }) => [name, value]))
}

/**
 * How `mcp_client` reaches a server the client sent, or undefined for a
 * transport it doesn't speak. A stdio server starts in the session's cwd
 * with the variables the client gave it on top of the MCP SDK's own short
 * list, so it doesn't inherit the agent's provider keys.
 */
function client_config(server: McpServer, cwd: string): McpClientConfig | undefined {
  if ('command' in server) {
    return { transport: 'stdio', command: server.command, args: [...server.args], env: record_of(server.env), cwd }
  }
  if (server.type === 'http') return { transport: 'http', url: server.url, headers: record_of(server.headers) }
  return undefined
}

/**
 * `text` with every `env` and `headers` value of `server` that's long
 * enough to be a credential cut out, since an error that quotes one would
 * carry it to stderr and to the client.
 */
function without_secrets(server: McpServer, text: string): string {
  const pairs = 'command' in server ? server.env : 'headers' in server ? server.headers : []
  return pairs.reduce((cut, { value }) => (value.length < SECRET_LENGTH ? cut : cut.replaceAll(value, '[redacted]')), text)
}

/**
 * The warning for a server left out of the session, also written to
 * stderr, for a client that shows no notices.
 */
function left_out(server: McpServer, reason: string): McpWarning {
  const description = `${without_secrets(server, reason)}, so its tools are left out of the session`
  warn(`MCP server ${server.name}: ${description}`)
  return { title: `MCP server ${server.name} isn't connected`, description }
}

/**
 * Connect to one server, or return the warning that says why it was left
 * out, so the session starts without it. A missing MCP SDK isn't one
 * server's failure, so that error is thrown on.
 */
async function connect_server(
  server: McpServer,
  cwd: string,
  identity: McpIdentity,
): Promise<McpClientHandle | McpWarning> {
  const config = client_config(server, cwd)
  if (config === undefined) return left_out(server, "it uses a transport this agent doesn't speak")
  const name_prefix = `mcp__${server.name.replaceAll(/[^\w-]/g, '_')}__`
  try {
    return await mcp_client(config, { client_info: identity, name_prefix })
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'mcp_sdk_missing_error') throw err
    return left_out(server, `it couldn't be reached (${err instanceof Error ? err.message : String(err)})`)
  }
}

/**
 * Close every connection, warning about any that fails to close rather
 * than leaving the others open.
 */
async function close_all(handles: ReadonlyArray<McpClientHandle>): Promise<void> {
  const results = await Promise.allSettled(handles.map((handle) => handle.close()))
  for (const result of results) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason
      warn(`couldn't close an MCP server (${reason instanceof Error ? reason.message : String(reason)})`)
    }
  }
}

/**
 * A tool's name cut to the limit, ending in a hash of the server it came
 * from (by its place in the list and its name as the client sent it) and
 * the name `mcp_client` gave the tool, so two tools that would share a name
 * each get one of their own.
 */
function shortened(name: string, server: McpServer, index: number): string {
  const hash = createHash('sha256').update(`${index}\0${server.name}\0${name}`).digest('hex').slice(0, HASH_LENGTH)
  return `${name.slice(0, NAME_LIMIT - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Whether `value` is a connection instead of the warning that stands in
 * for one.
 */
function is_handle(value: McpClientHandle | McpWarning): value is McpClientHandle {
  return 'tools' in value
}

/**
 * Connect to every server the client sent for a session, all at once, and
 * gather their tools under names no two of them share and no provider
 * refuses.
 */
export async function connect_mcp_servers(
  servers: ReadonlyArray<McpServer>,
  cwd: string,
  identity: McpIdentity,
): Promise<McpConnections> {
  if (servers.length === 0) return NO_MCP
  const settled = await Promise.allSettled(servers.map((server) => connect_server(server, cwd, identity)))
  const connected = settled.map((result) => (result.status === 'fulfilled' ? result.value : undefined))
  const handles = connected.filter((entry) => entry !== undefined).filter(is_handle)
  const failed = settled.find((result) => result.status === 'rejected')
  if (failed !== undefined) {
    await close_all(handles)
    throw failed.reason
  }
  const tools = new Map<string, Tool>()
  const warnings: McpWarning[] = []
  connected.forEach((entry, index) => {
    const server = servers[index]
    if (entry === undefined || server === undefined) return
    if (!is_handle(entry)) {
      warnings.push(entry)
      return
    }
    for (const tool of entry.tools) {
      const name = tool.name.length > NAME_LIMIT || tools.has(tool.name) ? shortened(tool.name, server, index) : tool.name
      if (tools.has(name)) warn(`MCP server ${server.name} offers a tool named ${tool.name} twice, so the second one is left out`)
      else tools.set(name, name === tool.name ? tool : { ...tool, name })
    }
  })
  return { tools: [...tools.values()], close: () => close_all(handles), warnings }
}

/**
 * Whether one of the session's MCP tools was asked about this very input,
 * which makes the call one of theirs rather than a call to a tool that only
 * shares a name with one.
 */
export function is_mcp_call(session: AcpSession, input: unknown): boolean {
  return is_record(input) && asked.get(session)?.has(input) === true
}

/**
 * The session's MCP tools, each asking before it runs whenever the
 * session's mode asks before a command, and marking the input it was asked
 * about as one of the session's own MCP calls. The tools are made as the
 * session is, so they reach it through `session` at each call.
 */
export function gated_mcp_tools(tools: ReadonlyArray<Tool>, session: () => AcpSession): ReadonlyArray<Tool> {
  return tools.map((tool) => ({
    ...tool,
    needs_approval: (input: unknown) => {
      const current = session()
      const inputs = asked.get(current) ?? new WeakSet<object>()
      asked.set(current, inputs)
      if (is_record(input)) inputs.add(input)
      return asks_before(current.mode(), 'command')
    },
  }))
}
