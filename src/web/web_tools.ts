/**
 * web_tools: the tools that let an agent read the web.
 */

import type { Tool } from '#engine'
import type { WebToolsOptions } from './types.js'

/**
 * Build `web_fetch`, and `web_search` too when the options carry a search
 * backend.
 */
export function web_tools(options: WebToolsOptions = {}): ReadonlyArray<Tool> {
  throw new Error(`not implemented: web_tools(${String(options.search)})`)
}
