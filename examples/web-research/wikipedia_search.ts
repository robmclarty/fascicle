/**
 * wikipedia_search: a `WebSearch` over one index, written by hand.
 *
 * MediaWiki's search API needs no key, which is what lets the example run
 * with nothing but a model key. It is also the whole of what a search over an
 * index of your own takes: turn `{ query, limit }` into a request, pass the
 * abort signal along, and map what comes back to `{ title, url, snippet }`.
 */

import { z } from 'zod'

import type { WebSearch, WebSearchResult } from 'fascicle/web'

const API_URL = 'https://en.wikipedia.org/w/api.php'

const search_response = z.object({
  query: z.object({
    search: z.array(z.object({ title: z.string(), snippet: z.string() })),
  }),
})

/**
 * Turn a MediaWiki snippet into plain text.
 *
 * The API marks each matched word with a `span`, and it escapes the text
 * around them, so the tags go and the few entities it uses are decoded.
 */
function plain_snippet(html: string): string {
  return html
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

/**
 * Search English Wikipedia and return its hits as `WebSearchResult`s.
 *
 * A hit carries a title and no URL, so the article's address is built from
 * the title the way Wikipedia builds it, with underscores for spaces. The API
 * returns ten hits unless asked for more, so the request names the `limit`.
 */
export const wikipedia_search: WebSearch = async ({ query, limit }, ctx) => {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(limit),
    format: 'json',
  })
  const res = await fetch(`${API_URL}?${params.toString()}`, {
    headers: { 'User-Agent': 'fascicle-web-research (+https://github.com/robmclarty/fascicle)' },
    signal: ctx.abort,
  })
  if (!res.ok) {
    throw new Error(`Wikipedia search answered ${String(res.status)}; try the query again in a moment`)
  }
  const body = search_response.parse(await res.json())
  return body.query.search.slice(0, limit).map(
    (hit): WebSearchResult => ({
      title: hit.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replaceAll(' ', '_'))}`,
      snippet: plain_snippet(hit.snippet),
    }),
  )
}
