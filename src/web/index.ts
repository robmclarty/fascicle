/**
 * Web subpath for Fascicle: tools that let an agent read the web.
 *
 * `web_tools(options)` returns `web_fetch`, and `web_search` too when the
 * options carry a search backend. Both are ordinary `Tool` values that run in
 * the app's own process, so they work on every provider. `web_fetch` refuses
 * loopback, private, and link-local addresses on the first request and on
 * every redirect, and it connects to the address it checked.
 *
 * `searxng_search` and `brave_search` each build the `WebSearch` function
 * that `options.search` takes, the first over a SearXNG server the app's
 * owner runs and the second over Brave's hosted index with a key.
 */

export { web_tools } from './web_tools.js'
export { searxng_search } from './searxng_search.js'
export { brave_search } from './brave_search.js'
export type {
  BraveSearchConfig,
  SearxngSearchConfig,
  WebSearch,
  WebSearchContext,
  WebSearchRequest,
  WebSearchResult,
  WebToolsOptions,
} from './types.js'
