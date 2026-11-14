/**
 * Lazy loaders for the optional `@a2a-js/sdk` peer.
 *
 * The adapter needs SDK values (the request handler, the JSON-RPC transport,
 * the client factory, the wire enums), so it imports the SDK dynamically
 * instead of statically. A consumer can import `fascicle/a2a` without the
 * SDK installed and only pays for it when they serve a flow or call a remote
 * agent. A missing peer surfaces as a typed `a2a_sdk_missing_error` that
 * says how to install it, the way src/acp/sdk_loader.ts and
 * src/mcp/sdk_loader.ts do for theirs.
 *
 * The SDK publishes each entry point as a bundle of its own, so the server
 * half and the client half load apart, and a flow that only calls a remote
 * agent never loads the request handler.
 */

import { a2a_sdk_missing_error } from './errors.js'

/**
 * Throw the typed missing-peer error for a failed import of the SDK.
 */
function missing(err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err)
  throw new a2a_sdk_missing_error(
    `@a2a-js/sdk is required for fascicle/a2a; install it: pnpm add @a2a-js/sdk (cause: ${detail})`,
  )
}

/**
 * Dynamically imports what serving needs of `@a2a-js/sdk`: the wire types'
 * codecs and enums, the server, and the protocol's errors. Throws a typed
 * `a2a_sdk_missing_error` when the optional peer is not installed.
 */
export async function load_a2a_server() {
  try {
    const [wire, server, errors] = await Promise.all([
      import('@a2a-js/sdk'),
      import('@a2a-js/sdk/server'),
      import('@a2a-js/sdk/errors'),
    ])
    return { wire, server, errors }
  } catch (err: unknown) {
    return missing(err)
  }
}

/**
 * Dynamically imports what calling a remote agent needs of `@a2a-js/sdk`:
 * the wire enums and the client. Throws a typed `a2a_sdk_missing_error` when
 * the optional peer is not installed.
 */
export async function load_a2a_client() {
  try {
    const [wire, client] = await Promise.all([import('@a2a-js/sdk'), import('@a2a-js/sdk/client')])
    return { wire, client }
  } catch (err: unknown) {
    return missing(err)
  }
}

export type A2aServerSdk = Awaited<ReturnType<typeof load_a2a_server>>
export type A2aClientSdk = Awaited<ReturnType<typeof load_a2a_client>>
