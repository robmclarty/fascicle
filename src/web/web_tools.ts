/**
 * web_tools: the tools that let an agent read the web.
 *
 * `web_fetch` is always there, since it needs no key and no backend.
 * `web_search` joins it when the app passes a search function, because no
 * general index answers a query without a key or a server of the app's own.
 */

import type { Tool } from '#engine'
import type { WebToolsOptions } from './types.js'
import { web_fetch_tool } from './web_fetch.js'
import { web_search_tool } from './web_search.js'

/**
 * Build `web_fetch`, and `web_search` too when the options carry a search
 * backend.
 */
export function web_tools(options: WebToolsOptions = {}): ReadonlyArray<Tool> {
  return [web_fetch_tool(options), ...(options.search !== undefined ? [web_search_tool(options.search)] : [])]
}
