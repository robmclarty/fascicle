/**
 * Typed errors for the MCP adapter.
 *
 * Listed alongside src/core/errors.ts and src/engine/errors.ts in the
 * `no-class` rule ignores: `instanceof` branching is how callers distinguish a
 * missing optional peer from a tool-level failure surfaced over the wire, and
 * either of those from a server that wants credentials.
 */

export class mcp_sdk_missing_error extends Error {
  readonly kind = 'mcp_sdk_missing_error' as const;
  constructor(
    message = '@modelcontextprotocol/sdk is required for fascicle/mcp; install it: pnpm add @modelcontextprotocol/sdk',
  ) {
    super(message)
    this.name = 'mcp_sdk_missing_error'
  }
}

export class mcp_error extends Error {
  readonly kind = 'mcp_error' as const;
  readonly tool_name: string | undefined;
  constructor(message: string, metadata: { tool_name?: string } = {}) {
    super(message)
    this.name = 'mcp_error'
    this.tool_name = metadata.tool_name
  }
}

/**
 * An HTTP MCP server answered that the caller isn't authorized, while
 * connecting or on a later request once a token has expired. `url` is the
 * server's address without its query string or any credentials written into
 * it, and `cause` is the SDK's own error.
 */
export class mcp_auth_required_error extends Error {
  readonly kind = 'mcp_auth_required_error' as const;
  readonly url: string;
  constructor(url: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `MCP server at ${url} requires authorization (${detail}): pass \`auth_provider\` in the http config with a token the server accepts, or finish an interactive OAuth flow on a transport of your own and pass its client as \`transport: 'client'\``,
      { cause },
    )
    this.name = 'mcp_auth_required_error'
    this.url = url
  }
}
