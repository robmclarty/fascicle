/**
 * The transport of `web_fetch`: one GET over `node:http` or `node:https`
 * that connects only to an address the checks in `address.ts` passed.
 *
 * The global `fetch` resolves a host name again after any check a caller
 * makes, so this file resolves once, checks, and pins the connection to the
 * checked address. Redirects and decompression are its own to do for the
 * same reason.
 */

import type { TransportRequest, TransportResponse, WebDeps } from './types.js'

/**
 * GET a URL, following redirects, and return the final response with its
 * body decompressed and held to `fetch_limit_bytes`.
 */
export function fetch_url(request: TransportRequest, deps: WebDeps = {}): Promise<TransportResponse> {
  throw new Error(`not implemented: fetch_url(${request.url}, ${String(deps.resolve)})`)
}
