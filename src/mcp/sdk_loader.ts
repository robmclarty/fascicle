/**
 * Lazy loader for the optional `@modelcontextprotocol/sdk` peer.
 *
 * `mcp_client` needs SDK values (the Client and transport constructors), so it
 * imports them dynamically rather than statically: a consumer can import
 * `fascicle/mcp` without the SDK installed and only pays the cost when they
 * actually connect. A missing peer surfaces as a typed `mcp_sdk_missing_error`
 * with install guidance, mirroring the engine's `load_optional_peer`.
 *
 * `serve_flow` is not covered here: it operates on a caller-constructed
 * `McpServer`, so it needs only a type-only import and no runtime SDK load.
 */

import { mcp_sdk_missing_error } from './errors.js'

export type McpClientSdk = Awaited<ReturnType<typeof load_client_sdk>>

export async function load_client_sdk() {
  try {
    const [client_mod, stdio_mod, http_mod] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ])
    return {
      Client: client_mod.Client,
      StdioClientTransport: stdio_mod.StdioClientTransport,
      StreamableHTTPClientTransport: http_mod.StreamableHTTPClientTransport,
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new mcp_sdk_missing_error(
      `@modelcontextprotocol/sdk is required for fascicle/mcp; install it: pnpm add @modelcontextprotocol/sdk (cause: ${detail})`,
    )
  }
}
