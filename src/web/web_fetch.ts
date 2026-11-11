/**
 * web_fetch: read a web page as text, a window at a time.
 */

import type { Tool } from '#engine'
import type { WebDeps, WebToolsOptions } from './types.js'

/**
 * Build the `web_fetch` tool from the options `web_tools` was given.
 *
 * `deps` is internal. A test passes a resolver through it.
 */
export function web_fetch_tool(options: WebToolsOptions = {}, deps: WebDeps = {}): Tool {
  throw new Error(`not implemented: web_fetch_tool(${String(options.timeout_ms)}, ${String(deps.resolve)})`)
}
