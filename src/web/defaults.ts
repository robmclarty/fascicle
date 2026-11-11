/**
 * The defaults and caps of `fascicle/web`, in one place so that the tools,
 * the adapters, and their tests all read the same numbers.
 */

/** The most bytes of a body `web_fetch` reads unless the options say otherwise: 5 MB. */
export const DEFAULT_FETCH_LIMIT_BYTES = 5 * 1024 * 1024

/** The most characters one `web_fetch` call returns unless the options say otherwise. */
export const DEFAULT_OUTPUT_LIMIT_CHARS = 40_000

/** How long one `web_fetch` call may take unless the options say otherwise: 20 seconds. */
export const DEFAULT_TIMEOUT_MS = 20_000

/** How many redirects `web_fetch` follows unless the options say otherwise. */
export const DEFAULT_MAX_REDIRECTS = 5

/** The `User-Agent` that `web_fetch` sends, which names Fascicle so a site can refuse it. */
export const DEFAULT_USER_AGENT = 'fascicle-web (+https://github.com/robmclarty/fascicle)'

/** How many results `web_search` asks for when the model names no `limit`. */
export const DEFAULT_SEARCH_LIMIT = 8

/** The most results one `web_search` call asks for, whatever `limit` the model names. */
export const MAX_SEARCH_LIMIT = 20
