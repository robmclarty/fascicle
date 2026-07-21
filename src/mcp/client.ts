/**
 * Inbound MCP: connect to an external MCP server and surface its tools as plain
 * fascicle `Tool[]`.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool, ToolExecContext } from '#engine'
import { mcp_error } from './errors.js'
import { is_record } from './internal.js'
import { call_result_to_output } from './result_mapping.js'
import { json_schema_to_zod } from './schema_bridge.js'
import { load_client_sdk, type McpClientSdk } from './sdk_loader.js'

const DEFAULT_CLIENT_INFO = { name: 'fascicle', version: '0.0.0' }

export type McpStdioConfig = {
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export type McpStreamableHttpConfig = {
  transport: 'http'
  url: string
  headers?: Record<string, string>
}

// Escape hatch: hand in an already-connected Client (a transport the adapter
// does not build, a test harness, a shared connection). Its lifecycle stays
// with the caller, so the returned `close` is a no-op for this variant.
export type McpExistingClientConfig = {
  transport: 'client'
  client: Client
}

export type McpClientConfig =
  | McpStdioConfig
  | McpStreamableHttpConfig
  | McpExistingClientConfig

export type McpClientOptions = {
  // Identity sent in the MCP handshake; defaults to fascicle.
  client_info?: { name: string; version: string }
  // When set, only tools whose name is listed are surfaced.
  include?: ReadonlyArray<string>
  // Supplies a description for tools that advertise none.
  default_description?: (tool_name: string) => string
}

export type McpClientHandle = {
  readonly tools: ReadonlyArray<Tool>
  readonly close: () => Promise<void>
}

/**
 * Connects to an MCP server and surfaces its advertised tools as fascicle
 * `Tool[]`, plus a `close` handle for the connection.
 *
 * Owns the connection lifecycle (config in, `{ tools, close }` out) so callers
 * do not have to import SDK transport classes themselves. Each advertised MCP
 * tool becomes an ordinary `Tool`: its JSON Schema is bridged to Zod for the
 * loop's `safeParse` and the provider, and `execute` forwards to `callTool`,
 * propagating the run's abort signal. For the `client` transport variant the
 * caller keeps ownership of the connection, so `close` is a no-op.
 */
export async function mcp_client(
  config: McpClientConfig,
  options: McpClientOptions = {},
): Promise<McpClientHandle> {
  const owns_client = config.transport !== 'client'
  const client = await connect_client(config, options)

  const include = options.include !== undefined ? new Set(options.include) : undefined
  const listed = await client.listTools()
  const tools: Tool[] = []
  for (const advertised of listed.tools) {
    if (include !== undefined && !include.has(advertised.name)) continue
    tools.push(to_fascicle_tool(client, advertised, options))
  }

  return {
    tools,
    close: async () => {
      if (owns_client) await client.close()
    },
  }
}

/**
 * Returns the caller's already-connected client as-is, or lazily loads the
 * SDK and connects a fresh client over the configured transport.
 */
async function connect_client(
  config: McpClientConfig,
  options: McpClientOptions,
): Promise<Client> {
  if (config.transport === 'client') return config.client
  const sdk = await load_client_sdk()
  const client = new sdk.Client(options.client_info ?? DEFAULT_CLIENT_INFO)
  await client.connect(build_transport(sdk, config))
  return client
}

/**
 * Constructs the SDK transport matching the config: a spawned child process
 * for `stdio`, a Streamable HTTP connection for `http`.
 */
function build_transport(
  sdk: McpClientSdk,
  config: McpStdioConfig | McpStreamableHttpConfig,
): Transport {
  if (config.transport === 'stdio') {
    return new sdk.StdioClientTransport({
      command: config.command,
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(config.env !== undefined ? { env: config.env } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    })
  }
  const opts = config.headers !== undefined ? { requestInit: { headers: config.headers } } : {}
  // The SDK declares this class `implements Transport`, but its `onmessage`
  // overload is narrower than the interface's, which only strict mode flags.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return new sdk.StreamableHTTPClientTransport(new URL(config.url), opts) as Transport
}

/**
 * Wraps one advertised MCP tool as a fascicle `Tool` whose `execute` forwards
 * to `callTool` on the shared client.
 *
 * An already-aborted signal short-circuits before the wire call; otherwise the
 * signal is passed through so cancelling the run cancels the remote call.
 */
function to_fascicle_tool(
  client: Client,
  advertised: { name: string; description?: string | undefined; inputSchema: unknown },
  options: McpClientOptions,
): Tool {
  const name = advertised.name
  const description =
    advertised.description ?? options.default_description?.(name) ?? `MCP tool ${name}`
  return {
    name,
    description,
    input_schema: json_schema_to_zod(advertised.inputSchema),
    execute: async (input: unknown, ctx: ToolExecContext) => {
      if (ctx.abort.aborted) {
        throw ctx.abort.reason instanceof Error
          ? ctx.abort.reason
          : new mcp_error(`MCP tool ${name} aborted before invocation`, { tool_name: name })
      }
      const result = await client.callTool(
        { name, arguments: is_record(input) ? input : undefined },
        undefined,
        { signal: ctx.abort },
      )
      return call_result_to_output(result, name)
    },
  }
}
