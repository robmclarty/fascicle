/**
 * Typed errors for the MCP adapter.
 *
 * Listed alongside src/core/errors.ts and src/engine/errors.ts in the
 * `no-class` rule ignores: `instanceof` branching is how callers distinguish a
 * missing optional peer from a tool-level failure surfaced over the wire.
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
