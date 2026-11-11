/**
 * brave_search: a `WebSearch` over Brave's Search API.
 */

import type { BraveSearchConfig, WebSearch } from './types.js'

/**
 * Search through Brave's hosted index, with the key the app passes.
 */
export function brave_search(config: BraveSearchConfig): WebSearch {
  throw new Error(`not implemented: brave_search(${String(config.api_key.length)})`)
}
