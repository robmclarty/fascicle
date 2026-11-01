/**
 * mcp_servers: the MCP servers a client sends with a session, connected
 * for the session's flow.
 *
 * Zed sends the MCP servers its user configured with every session. An
 * agent whose config sets `mcp_servers` connects to each one through
 * `mcp_client` from fascicle/mcp and hands their tools to the flow builder.
 * A server that can't be reached is left out with a warning on stderr
 * rather than failing the session, so one broken entry in the editor's
 * settings can't stop every thread. Each tool is named
 * `mcp__<server>__<tool>`, the form Claude Code uses, so two servers' tools
 * don't collide and none takes a workspace tool's name. A name that two
 * servers still share after that goes to the first.
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

/** A session's MCP servers, connected: every tool they offer, and the way to close them all. */
export type McpConnections = {
  readonly tools: ReadonlyArray<Tool>
  readonly close: () => Promise<void>
}

/** The connections of a session with no MCP servers. */
export const NO_MCP: McpConnections = { tools: [], close: async () => {} }

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
 * Connect to one server, or warn and return undefined when it can't be
 * reached, so the session starts without it.
 */
async function connect_server(
  server: McpServer,
  cwd: string,
  identity: McpIdentity,
): Promise<McpClientHandle | undefined> {
  const config = client_config(server, cwd)
  if (config === undefined) {
    warn(`MCP server ${server.name} uses a transport this agent doesn't speak, so its tools are left out of the session`)
    return undefined
  }
  const name_prefix = `mcp__${server.name.replaceAll(/[^\w-]/g, '_')}__`
  try {
    return await mcp_client(config, { client_info: identity, name_prefix })
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    warn(`couldn't connect to MCP server ${server.name} (${reason}), so its tools are left out of the session`)
    return undefined
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
 * Connect to every server the client sent for a session, all at once, and
 * gather their tools, keeping the first tool to take each name.
 */
export async function connect_mcp_servers(
  servers: ReadonlyArray<McpServer>,
  cwd: string,
  identity: McpIdentity,
): Promise<McpConnections> {
  if (servers.length === 0) return NO_MCP
  const connected = await Promise.all(servers.map((server) => connect_server(server, cwd, identity)))
  const handles = connected.filter((handle) => handle !== undefined)
  const tools = new Map<string, Tool>()
  for (const tool of handles.flatMap((handle) => handle.tools)) {
    if (tools.has(tool.name)) warn(`two MCP servers offer a tool named ${tool.name}, so the second one's is left out`)
    else tools.set(tool.name, tool)
  }
  return { tools: [...tools.values()], close: () => close_all(handles) }
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
