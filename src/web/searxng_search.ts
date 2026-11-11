/**
 * searxng_search: a `WebSearch` over a SearXNG server the app's owner runs.
 */

import type { SearxngSearchConfig, WebSearch } from './types.js'

/**
 * Search through a SearXNG server the app's owner runs. No key.
 */
export function searxng_search(config: SearxngSearchConfig): WebSearch {
  throw new Error(`not implemented: searxng_search(${config.base_url})`)
}
