/**
 * web_search: ask the app's search backend, and list what it found.
 *
 * The tool owns the parts every backend would otherwise repeat. It rechecks
 * the input, holds `limit` to the cap before the backend sees it, and writes
 * the results as a numbered list whose URLs the model can hand to
 * `web_fetch`. The backend is any `WebSearch`, and a failure it throws goes
 * to the model as it was thrown, since the backend is the one that knows its
 * own name and status.
 */

import type { Tool } from '#engine'
import { as_record, json_schema_to_standard } from '#schema'
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from './defaults.js'
import type { WebSearch, WebSearchRequest, WebSearchResult } from './types.js'

/**
 * Whether a value counts results: a whole number of at least 1.
 */
function is_count(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1
}

/**
 * Read the call's query and limit out of its input, with `limit` held to the cap.
 *
 * The tool loop has already checked the types against the schema, but a flow
 * that wraps the tool can call `execute` directly, and the schema's `minimum`
 * and `maximum` are advice to the model rather than something the loop
 * enforces. A limit over the cap is held there and not refused, because the
 * model asked for more than it can have and the most it can have still
 * answers it.
 */
function search_request(input: unknown): WebSearchRequest {
  const fields: Record<string, unknown> = as_record(input) ?? {}
  const { query, limit = DEFAULT_SEARCH_LIMIT } = fields
  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error("web_search needs a query, as a string that isn't blank")
  }
  if (!is_count(limit)) {
    throw new Error('web_search counts limit in results, so it has to be a whole number of at least 1')
  }
  return { query, limit: Math.min(limit, MAX_SEARCH_LIMIT) }
}

/**
 * One result as the model sees it: its number and title, then its URL, then
 * its snippet when the index gave one.
 *
 * The URL and the snippet sit under the title, indented past the number, so
 * the URL is alone on its line and the model can copy it whole.
 */
function entry(result: WebSearchResult, position: number): string {
  const lines = [`${position}. ${result.title}`, `   ${result.url}`]
  if (result.snippet !== '') lines.push(`   ${result.snippet}`)
  return lines.join('\n')
}

/**
 * Build the `web_search` tool around a search backend.
 *
 * The backend gets the call's abort signal, so a cancelled turn stops the
 * request it has in flight. What it returns is cut to `limit` again here,
 * since a backend of the app's own may not count.
 */
export function web_search_tool(search: WebSearch): Tool {
  return {
    name: 'web_search',
    description:
      `Search the web. Returns a numbered list of results, each with a title, a URL, and a snippet of the page; ` +
      `pass a URL to web_fetch to read the page. Returns ${DEFAULT_SEARCH_LIMIT} results unless limit says otherwise, ` +
      `and at most ${MAX_SEARCH_LIMIT}.`,
    input_schema: json_schema_to_standard({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `How many results to return; default: ${DEFAULT_SEARCH_LIMIT}, most: ${MAX_SEARCH_LIMIT}`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    read_only: true,
    execute: async (input, ctx) => {
      const request = search_request(input)
      const results = await search(request, { abort: ctx.abort })
      if (results.length === 0) return `No results for "${request.query}".`
      return results
        .slice(0, request.limit)
        .map((result, index) => entry(result, index + 1))
        .join('\n\n')
    },
  }
}
