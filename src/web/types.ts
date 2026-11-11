/**
 * The types of `fascicle/web`: the public options and search contract first,
 * then the internal records the module's files hand each other.
 *
 * The barrel re-exports only the public half. The internal half is the seam
 * between the address checks, the transport, and the tools, and it is where
 * a test swaps the DNS resolver without the public options growing a field.
 */

import type { Tool } from '#engine'

/** One search: the query as the model wrote it, and the most results wanted. */
export type WebSearchRequest = {
  readonly query: string
  /** A whole number from 1 to 20. `web_search` has already held it there. */
  readonly limit: number
}

/** What a search backend gets beside the request: the call's abort signal. */
export type WebSearchContext = {
  readonly abort: AbortSignal
}

/** One search result, as `web_search` lists it for the model. */
export type WebSearchResult = {
  readonly title: string
  readonly url: string
  /** A line or two of the page around the match, or '' when the index gave none. */
  readonly snippet: string
}

/**
 * A search backend: any function from a query to results.
 *
 * `searxng_search` and `brave_search` build one, and an app with an index of
 * its own writes one. A failure is a thrown `Error` whose message names the
 * backend and its status, which the tool loop hands to the model.
 */
export type WebSearch = (
  request: WebSearchRequest,
  ctx: WebSearchContext,
) => Promise<ReadonlyArray<WebSearchResult>>

/** What `web_tools` takes. Every field is optional, and so is the argument. */
export type WebToolsOptions = {
  /** The search backend. Without one, `web_tools` returns `web_fetch` alone. */
  readonly search?: WebSearch
  /** Host names `web_fetch` may reach. Unset means any public host. */
  readonly allow_hosts?: ReadonlyArray<string>
  /** Host names `web_fetch` refuses, which win over `allow_hosts`. */
  readonly deny_hosts?: ReadonlyArray<string>
  /** Reach loopback, private, and link-local addresses too. Default false. */
  readonly allow_private?: boolean
  /** The most bytes of a body `web_fetch` reads, counted after decompression. Default 5 MB. */
  readonly fetch_limit_bytes?: number
  /** The most characters one `web_fetch` call returns. Default 40,000. */
  readonly output_limit_chars?: number
  /** How long one `web_fetch` call may take, redirects included. Default 20 seconds. */
  readonly timeout_ms?: number
  /** How many redirects `web_fetch` follows before it gives up. Default 5. */
  readonly max_redirects?: number
  /** The `User-Agent` header `web_fetch` sends. The default names Fascicle. */
  readonly user_agent?: string
  /** Replaces the built-in HTML converter. */
  readonly to_text?: (html: string, url: string) => string | Promise<string>
  /** Passed to `web_fetch` as its `needs_approval`. */
  readonly needs_approval?: Tool['needs_approval']
}

/** What `searxng_search` takes: where the app's own SearXNG server listens. */
export type SearxngSearchConfig = {
  /** The server's root, such as `http://localhost:8888`. A path prefix is kept. */
  readonly base_url: string
}

/** What `brave_search` takes: the key for Brave's Search API. */
export type BraveSearchConfig = {
  readonly api_key: string
}

/**
 * The rules one fetch runs under, with every default already resolved.
 *
 * `allow_hosts` keeps `undefined` apart from an empty list. Unset allows any
 * host, and an empty list allows none.
 */
export type AddressPolicy = {
  readonly allow_hosts: ReadonlyArray<string> | undefined
  readonly deny_hosts: ReadonlyArray<string>
  readonly allow_private: boolean
}

/** One address a host name resolved to, in the shape `dns.lookup` gives. */
export type ResolvedAddress = {
  readonly address: string
  readonly family: 4 | 6
}

/** Resolve a host name to every address it has. Rejects when it has none. */
export type ResolveHost = (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>

/**
 * The internal second argument of `fetch_url` and `web_fetch_tool`, which is
 * how a test names the addresses a host resolves to.
 */
export type WebDeps = {
  /** Replaces the `node:dns` lookup. */
  readonly resolve?: ResolveHost
}

/** The start of the final response, known before any of its body is read. */
export type TransportHead = {
  /** The URL that answered, after every redirect. */
  readonly url: string
  readonly status: number
  /** The `Content-Type` header as the server sent it, or undefined when it sent none. */
  readonly content_type: string | undefined
}

/** One GET, with every limit resolved. */
export type TransportRequest = {
  readonly url: string
  readonly policy: AddressPolicy
  readonly fetch_limit_bytes: number
  readonly timeout_ms: number
  readonly max_redirects: number
  readonly user_agent: string
  readonly abort: AbortSignal
  /**
   * Called once with the final response's head, before its body is read. A
   * throw from it ends the request and rejects `fetch_url` with that error,
   * which is how `web_fetch` refuses a PDF without downloading it.
   */
  readonly check_head?: (head: TransportHead) => void
}

/** What a GET came back with: the head, and the body after decompression. */
export type TransportResponse = TransportHead & {
  /** At most `fetch_limit_bytes` of the decompressed body. */
  readonly body: Buffer
  /** True when the body went on past `fetch_limit_bytes` and was cut there. */
  readonly truncated: boolean
}
