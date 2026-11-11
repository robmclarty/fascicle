/**
 * searxng_search: a `WebSearch` over a SearXNG server the app's owner runs.
 *
 * The adapter calls one fixed server that the app chose, so it uses the global
 * `fetch` and runs none of the address checks `web_fetch` does, which is what
 * lets it reach `localhost`. SearXNG has no parameter for a result count, so
 * the adapter asks for the first page and cuts it to the limit itself.
 */

import { as_record } from '#schema'
import { MAX_SEARCH_LIMIT } from './defaults.js'
import type { SearxngSearchConfig, WebSearch, WebSearchResult } from './types.js'

/**
 * Search through a SearXNG server the app's owner runs. No key.
 *
 * `base_url` is checked once, when the adapter is built, so a typo fails at
 * startup and not on the model's first search. The server has to list `json`
 * under `search.formats` in its settings.yml. It answers 403 when that is
 * missing, and the message for a 403 says so.
 */
export function searxng_search(config: SearxngSearchConfig): WebSearch {
  const { base_url } = config
  const endpoint = parse_endpoint(base_url)
  return async (request, ctx) => {
    const url = new URL(endpoint)
    url.searchParams.set('q', request.query)
    url.searchParams.set('format', 'json')
    let response: Response
    try {
      response = await fetch(url.href, {
        headers: { Accept: 'application/json' },
        signal: ctx.abort,
      })
    } catch (cause) {
      if (ctx.abort.aborted) throw cause
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new Error(
        `could not reach SearXNG at ${base_url}: ${reason}; check that the server is running and base_url is right`,
        { cause },
      )
    }
    // A format that is switched off answers 403 with an HTML page, so the
    // status alone decides and the body is never read.
    if (response.status === 403) {
      throw new Error(
        `SearXNG at ${base_url} answered 403, most likely because json is not among its search.formats; add json under search.formats in settings.yml and restart the server`,
      )
    }
    const body = as_record(await read_json(response, ctx.abort))
    if (!response.ok) {
      const error = body?.['error']
      const detail = typeof error === 'string' ? `: ${error}` : ''
      throw new Error(`SearXNG at ${base_url} answered ${response.status}${detail}`)
    }
    const results = body?.['results']
    if (!Array.isArray(results)) {
      throw new Error(
        `SearXNG at ${base_url} answered 200 with a body that isn't its JSON search result`,
      )
    }
    if (results.length === 0) {
      const names = engine_names(body?.['unresponsive_engines'])
      if (names.length > 0) {
        throw new Error(
          `SearXNG at ${base_url} found nothing because its engines did not answer (${names.join(', ')})`,
        )
      }
    }
    return results
      .map(to_result)
      .filter((result) => result.url !== '')
      .slice(0, Math.min(request.limit, MAX_SEARCH_LIMIT))
  }
}

/**
 * Turns `base_url` into the URL of the server's search route, or throws.
 *
 * A path prefix stays, since a server behind a reverse proxy often lives
 * under one, and a trailing slash goes so the route isn't doubled. A query
 * string or a fragment on `base_url` is dropped. A username or password is
 * refused, and the refusal names the host alone, since `fetch` rejects such a
 * URL anyway and every later message repeats `base_url`.
 */
function parse_endpoint(base_url: string): string {
  let url: URL
  try {
    url = new URL(base_url)
  } catch {
    throw new Error(
      `searxng_search needs base_url as an http or https URL, and got "${base_url}"`,
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      `searxng_search needs base_url without a username or password, and got one for ${url.host}`,
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `searxng_search needs base_url as an http or https URL, and got "${base_url}"`,
    )
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`
  url.search = ''
  url.hash = ''
  return url.href
}

/**
 * Reads a response body as JSON, and gives `undefined` for one that isn't.
 *
 * A body that fails because the call was aborted rethrows the abort, so a
 * cancelled search never reads as a server that sent the wrong thing.
 */
async function read_json(response: Response, abort: AbortSignal): Promise<unknown> {
  try {
    return await response.json()
  } catch (err) {
    if (abort.aborted) throw err
    return undefined
  }
}

/**
 * Maps one entry of SearXNG's `results` to a `WebSearchResult`.
 *
 * Each field is an optional string on the wire (some engines send no
 * `content`, and `url` can be null), so a missing one becomes ''.
 */
function to_result(entry: unknown): WebSearchResult {
  const record = as_record(entry)
  return {
    title: text_of(record?.['title']),
    url: text_of(record?.['url']),
    snippet: text_of(record?.['content']),
  }
}

/**
 * Gives a string back as it is, and '' for anything else.
 */
function text_of(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Lists the engine names in SearXNG's `unresponsive_engines`.
 *
 * The server sends each one as a `[name, error text]` pair.
 */
function engine_names(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const pair of value) {
    const name: unknown = Array.isArray(pair) ? pair[0] : undefined
    if (typeof name === 'string') names.push(name)
  }
  return names
}
