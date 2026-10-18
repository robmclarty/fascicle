/**
 * Lazy loader for the optional `@agentclientprotocol/sdk` peer.
 *
 * The adapter needs SDK values (the `agent()` builder, `ndJsonStream`,
 * `RequestError`), so it imports the SDK dynamically rather than statically:
 * a consumer can import `fascicle/acp` without the SDK installed and only pays
 * for it when they serve a flow. A missing peer surfaces as a typed
 * `acp_sdk_missing_error` with install guidance, mirroring
 * src/mcp/sdk_loader.ts.
 *
 * The package root is the SDK's stable protocol v1 entry; v2 sits under its
 * `experimental/` subpaths, which fascicle never imports. The SDK imports
 * `zod/v4` at runtime as its own peer, so a missing zod fails here too, and
 * the error names both installs.
 */

import { acp_sdk_missing_error } from './errors.js'

/**
 * Dynamically imports the `@agentclientprotocol/sdk` v1 entry, throwing a
 * typed `acp_sdk_missing_error` when the optional peer (or its zod peer) is
 * not installed.
 */
export async function load_acp_sdk() {
  try {
    return await import('@agentclientprotocol/sdk')
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new acp_sdk_missing_error(
      `@agentclientprotocol/sdk is required for fascicle/acp; install it with its zod peer: pnpm add @agentclientprotocol/sdk zod (cause: ${detail})`,
    )
  }
}
