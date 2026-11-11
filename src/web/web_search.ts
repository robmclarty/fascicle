/**
 * web_search: ask the app's search backend, and list what it found.
 */

import type { Tool } from '#engine'
import type { WebSearch } from './types.js'

/**
 * Build the `web_search` tool around a search backend.
 */
export function web_search_tool(search: WebSearch): Tool {
  throw new Error(`not implemented: web_search_tool(${search.name})`)
}
