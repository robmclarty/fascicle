/**
 * Inbound MCP: connect to an external MCP server and surface its tools as plain
 * Fascicle `Tool[]`.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool, ToolExecContext } from '#engine'
import { is_record, json_schema_to_standard } from '#schema'
import { mcp_auth_required_error, mcp_error } from './errors.js'
import { create_resources, type McpResources } from './resources.js'
import { call_result_to_output } from './result_mapping.js'
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
  // The SDK's OAuth provider interface, for a token that expires, refreshes,
  // or comes from a `client_credentials` grant. The transport asks it for a
  // token on each request. A flow that needs the user in a browser doesn't
  // fit here: run it on a transport of your own and pass `transport: 'client'`.
  auth_provider?: OAuthClientProvider
  // Replaces the global `fetch` for every request the transport makes, the
  // OAuth ones included (a proxy, a recorder, a test double).
  fetch?: McpFetch
  // Rejoins a session the server already knows. The handshake is skipped, so
  // the server's capabilities are unknown to this connection.
  session_id?: string
  // How the transport retries a dropped event stream.
  reconnection?: McpReconnectionOptions
}

export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

/**
 * The backoff for reopening a dropped event stream. The wait before retry
 * `n` (counting from zero) is `initial_delay_ms * delay_grow_factor^n`, capped
 * at `max_delay_ms`, and the transport gives up after `max_retries`.
 */
export type McpReconnectionOptions = {
  max_retries: number
  initial_delay_ms: number
  max_delay_ms: number
  delay_grow_factor: number
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
  // Identity sent in the MCP handshake; defaults to Fascicle.
  client_info?: { name: string; version: string }
  // When set, only tools whose name is listed are surfaced.
  include?: ReadonlyArray<string>
  // Supplies a description for tools that advertise none.
  default_description?: (tool_name: string) => string
  // Prepended, as written, to each surfaced tool's name, so two servers'
  // tools can share a call without colliding. The server is still called by
  // its own name, and `include` and `default_description` see that name too.
  name_prefix?: string
  // Marks surfaced tools as needing approval, so the engine asks
  // `on_tool_approval` before each call and refuses the call when no handler
  // is set. Unset (the default) gates nothing. See McpApprovalPolicy.
  needs_approval?: McpApprovalPolicy
}

/**
 * What a server advertised about one tool, as an approval policy sees it. The
 * name is the server's own, without `name_prefix`. `annotations` holds the
 * hints the server sent (`readOnlyHint`, `destructiveHint`, and so on), and it
 * is absent when the server sent none. The server wrote those hints, so a
 * policy that trusts them trusts the server.
 */
export type McpAdvertisedTool = {
  name: string
  annotations?: Record<string, unknown>
}

/**
 * Which surfaced tools need approval. `true` gates every tool and `false`
 * gates none. A function is called once for each tool as it is surfaced, and
 * answers for that tool with a boolean or with a predicate over the call's
 * input, which becomes the tool's own `needs_approval`.
 */
export type McpApprovalPolicy =
  | boolean
  | ((tool: McpAdvertisedTool) => boolean | ((input: unknown) => boolean | Promise<boolean>))

export type McpClientHandle = {
  readonly tools: ReadonlyArray<Tool>
  readonly close: () => Promise<void>
  // What the server publishes besides tools. `mcp_client` always sets it, and
  // it costs nothing until a method is called. The type leaves it optional so
  // a handle built by hand (a test double, say) can stop at `tools` and
  // `close`.
  readonly resources?: McpResources
}

/**
 * Connects to an MCP server and surfaces its advertised tools as Fascicle
 * `Tool[]`, plus a `close` handle for the connection.
 *
 * Owns the connection lifecycle (config in, `{ tools, close }` out) so callers
 * do not have to import SDK transport classes themselves. Each advertised MCP
 * tool becomes an ordinary `Tool`: its JSON Schema is wrapped as a `ToolSchema`
 * the loop validates against and the provider receives back unchanged, and
 * `execute` forwards to `callTool`, propagating the run's abort signal. For the
 * `client` transport variant the caller keeps ownership of the connection, so
 * `close` is a no-op. A connection this call opened is closed again when
 * listing its tools fails. A server that advertises no tools is not asked
 * for any, and its handle carries an empty `tools` beside its `resources`.
 */
export async function mcp_client(
  config: McpClientConfig,
  options: McpClientOptions = {},
): Promise<McpClientHandle> {
  const { client, owned, translate } = await open_connection(config, options)

  const include = options.include !== undefined ? new Set(options.include) : undefined
  const listed = advertises_no_tools(client)
    ? { tools: [] }
    : await client.listTools().catch(async (err: unknown) => {
        // A client this call connected has no other owner yet, so it closes
        // here, taking a spawned stdio server with it. The listing failure is
        // the one the caller sees, even if the close fails too.
        if (owned) await client.close().catch(() => undefined)
        throw translate(err)
      })
  const tools: Tool[] = []
  for (const advertised of listed.tools) {
    if (include !== undefined && !include.has(advertised.name)) continue
    tools.push(to_fascicle_tool(client, advertised, options, translate))
  }

  return {
    tools,
    close: async () => {
      if (owned) await client.close()
    },
    resources: create_resources(client, translate),
  }
}

/**
 * True when the handshake said the server has no tools at all, as a server
 * that only publishes resources does. Asking such a server to list its tools
 * is answered with a JSON-RPC error, so the handle carries an empty `tools`
 * instead. A connection with no handshake to read (a session rejoined by
 * `session_id`) is asked.
 */
function advertises_no_tools(client: Client): boolean {
  const capabilities = client.getServerCapabilities()
  return capabilities !== undefined && capabilities.tools === undefined
}

/** Turns an error from the SDK into the one the caller should see. */
type ErrorTranslator = (err: unknown) => unknown

type Connection = {
  client: Client
  // False for a client the caller connected, whose lifecycle stays theirs.
  owned: boolean
  translate: ErrorTranslator
}

/**
 * Returns the caller's already-connected client as-is, or lazily loads the
 * SDK and connects a fresh client over the configured transport.
 *
 * An `http` connection carries a translator that turns the SDK's auth
 * failures into `mcp_auth_required_error`, for the handshake and for every
 * later request. A client the caller connected keeps the SDK's errors as they
 * are, since the caller built its transport and already holds the SDK.
 */
async function open_connection(
  config: McpClientConfig,
  options: McpClientOptions,
): Promise<Connection> {
  if (config.transport === 'client') {
    return { client: config.client, owned: false, translate: same_error }
  }
  const sdk = await load_client_sdk()
  const translate = config.transport === 'http' ? auth_translator(sdk, config.url) : same_error
  const client = new sdk.Client(options.client_info ?? DEFAULT_CLIENT_INFO)
  await client.connect(build_transport(sdk, config)).catch((err: unknown) => {
    throw translate(err)
  })
  return { client, owned: true, translate }
}

/** The translator for a connection whose errors pass through untouched. */
function same_error(err: unknown): unknown {
  return err
}

/**
 * Builds the translator for one HTTP server: an auth failure becomes
 * `mcp_auth_required_error`, and anything else passes through.
 *
 * The SDK reports an auth failure two ways. With an `authProvider` whose
 * flow ends short of a usable token it throws `UnauthorizedError`, from the
 * handshake or from any later request. With no provider, or when the server
 * still answers 401 to a fresh token, the POST fails as a
 * `StreamableHTTPError` whose `code` is 401. The error names the server by
 * origin and path only, since a query string or userinfo can hold a secret.
 */
function auth_translator(sdk: McpClientSdk, url: string): ErrorTranslator {
  const parsed = new URL(url)
  const shown = `${parsed.origin}${parsed.pathname}`
  return (err) => {
    const unauthorized =
      err instanceof sdk.UnauthorizedError ||
      (err instanceof sdk.StreamableHTTPError && err.code === 401)
    return unauthorized ? new mcp_auth_required_error(shown, err) : err
  }
}

/**
 * Constructs the SDK transport matching the config: a spawned child process
 * for `stdio`, a Streamable HTTP connection for `http`. Each option reaches
 * the SDK only when the config sets it, so the SDK's own defaults hold for
 * the rest.
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
  const reconnection = config.reconnection
  return new sdk.StreamableHTTPClientTransport(new URL(config.url), {
    ...(config.headers !== undefined ? { requestInit: { headers: config.headers } } : {}),
    ...(config.auth_provider !== undefined ? { authProvider: config.auth_provider } : {}),
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    ...(config.session_id !== undefined ? { sessionId: config.session_id } : {}),
    ...(reconnection !== undefined
      ? {
          reconnectionOptions: {
            maxRetries: reconnection.max_retries,
            initialReconnectionDelay: reconnection.initial_delay_ms,
            maxReconnectionDelay: reconnection.max_delay_ms,
            reconnectionDelayGrowFactor: reconnection.delay_grow_factor,
          },
        }
      : {}),
  })
}

type AdvertisedTool = {
  name: string
  description?: string | undefined
  inputSchema: unknown
  annotations?: Record<string, unknown> | undefined
}

/**
 * Settles the approval policy for one advertised tool into the value its
 * `Tool.needs_approval` carries, or undefined when no policy is set.
 *
 * A function policy runs here, once, with the server's own name for the tool
 * and the annotations it advertised. Nothing in this module reads the
 * annotations: they are the server's claims about itself, and whether to
 * believe them is the policy's decision.
 */
function resolve_needs_approval(
  policy: McpApprovalPolicy | undefined,
  advertised: AdvertisedTool,
): Tool['needs_approval'] {
  if (typeof policy !== 'function') return policy
  return policy({
    name: advertised.name,
    ...(advertised.annotations !== undefined ? { annotations: advertised.annotations } : {}),
  })
}

/**
 * Wraps one advertised MCP tool as a Fascicle `Tool` whose `execute` forwards
 * to `callTool` on the shared client. Only the `Tool`'s name carries
 * `name_prefix`; the call, the fallback description, and the errors use the
 * server's own name.
 *
 * An already-aborted signal short-circuits before the wire call; otherwise the
 * signal is passed through so cancelling the run cancels the remote call. A
 * failed call goes through `translate`, so a token that expired mid-session
 * reads the same as one that was refused at connect.
 */
function to_fascicle_tool(
  client: Client,
  advertised: AdvertisedTool,
  options: McpClientOptions,
  translate: ErrorTranslator,
): Tool {
  const name = advertised.name
  const description =
    advertised.description ?? options.default_description?.(name) ?? `MCP tool ${name}`
  const needs_approval = resolve_needs_approval(options.needs_approval, advertised)
  return {
    name: `${options.name_prefix ?? ''}${name}`,
    description,
    input_schema: json_schema_to_standard(advertised.inputSchema),
    ...(needs_approval !== undefined ? { needs_approval } : {}),
    execute: async (input: unknown, ctx: ToolExecContext) => {
      if (ctx.abort.aborted) {
        throw ctx.abort.reason instanceof Error
          ? ctx.abort.reason
          : new mcp_error(`MCP tool ${name} aborted before invocation`, { tool_name: name })
      }
      const result = await client
        .callTool({ name, arguments: is_record(input) ? input : undefined }, undefined, {
          signal: ctx.abort,
        })
        .catch((err: unknown) => {
          throw translate(err)
        })
      return call_result_to_output(result, name)
    },
  }
}
