/**
 * Typed errors for the ACP adapter.
 *
 * Listed alongside src/mcp/errors.ts in the `no-class` rule ignores:
 * `instanceof` branching is how callers tell a missing optional peer apart
 * from a failure inside a prompt turn.
 */

export class acp_sdk_missing_error extends Error {
  readonly kind = 'acp_sdk_missing_error' as const;
  constructor(
    message = '@agentclientprotocol/sdk is required for fascicle/acp; install it with its zod peer: pnpm add @agentclientprotocol/sdk zod',
  ) {
    super(message)
    this.name = 'acp_sdk_missing_error'
  }
}
