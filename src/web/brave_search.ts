/**
 * brave_search: a `WebSearch` over Brave's Search API.
 *
 * One GET per search, with the key in the `X-Subscription-Token` header and
 * nowhere else. Brave answers a bad key with 422 and the code
 * `SUBSCRIPTION_TOKEN_INVALID`, and 422 also covers a bad parameter, so the
 * adapter reads the code to tell the two apart. No message this file throws
 * contains the key.
 */

import { as_record } from '#schema'
import { MAX_SEARCH_LIMIT } from './defaults.js'
import type { BraveSearchConfig, WebSearch, WebSearchResult } from './types.js'

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const BAD_KEY_CODE = 'SUBSCRIPTION_TOKEN_INVALID'
const REDACTED = '[api_key]'

type Answer = { readonly status: number; readonly ok: boolean; readonly text: string }

/**
 * Build the search URL for one request.
 *
 * `count` is held to Brave's own range of 1 to 20 here as well as in
 * `web_search`, because an app can call the adapter directly.
 * `result_filter=web` leaves out the news and video blocks, and
 * `text_decorations=false` keeps `<strong>` tags out of titles and snippets.
 */
function search_url(query: string, limit: number): string {
  const count = Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT)
  const params = new URLSearchParams({
    q: query,
    count: String(count),
    result_filter: 'web',
    text_decorations: 'false',
  })
  return `${ENDPOINT}?${params.toString()}`
}

/**
 * Replace every occurrence of the key in a message.
 *
 * A key that is not a legal header value makes `fetch` quote it in its own
 * error, and a server is free to echo one back in `detail`.
 */
function scrub(message: string, api_key: string): string {
  return message.split(api_key).join(REDACTED)
}

/**
 * Parse a body as JSON, or return `undefined` when it is not JSON.
 */
function parse_json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Read `error.code` and `error.detail` out of Brave's error envelope.
 */
function error_envelope(body: unknown): { readonly code: string; readonly detail: string } | undefined {
  const error = as_record(as_record(body)?.['error'])
  const code = error?.['code']
  const detail = error?.['detail']
  if (typeof code !== 'string') return undefined
  return { code, detail: typeof detail === 'string' ? detail : '' }
}

/**
 * Build the error for a status outside 2xx.
 */
function status_error(answer: Answer, api_key: string): Error {
  const envelope = error_envelope(parse_json(answer.text))
  const named =
    envelope === undefined
      ? ''
      : envelope.detail === ''
        ? ` (${envelope.code})`
        : ` (${envelope.code}: ${envelope.detail})`
  const base = `Brave search answered ${String(answer.status)}${named}`
  if (envelope?.code === BAD_KEY_CODE || answer.status === 401 || answer.status === 403) {
    return new Error(scrub(`${base}; check the api_key passed to brave_search`, api_key))
  }
  if (answer.status === 429) {
    return new Error(
      scrub(`${base}; the key is over its rate limit or its quota, so wait before searching again`, api_key),
    )
  }
  return new Error(scrub(base, api_key))
}

/**
 * Build the error for a request that never got an answer.
 *
 * The cause is attached only when its own message is free of the key, so a
 * logger that walks the cause chain cannot print it either.
 */
function unreachable_error(cause: unknown, api_key: string): Error {
  const reason = cause instanceof Error ? cause.message : String(cause)
  const message = `could not reach Brave search: ${scrub(reason, api_key)}`
  return reason.includes(api_key) ? new Error(message) : new Error(message, { cause })
}

/**
 * Send one search and read the whole answer as text.
 *
 * An abort is rethrown as it came, whether it lands before the headers or
 * part of the way through the body.
 */
async function send(url: string, api_key: string, abort: AbortSignal): Promise<Answer> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-Subscription-Token': api_key, Accept: 'application/json' },
      signal: abort,
    })
    return { status: response.status, ok: response.ok, text: await response.text() }
  } catch (cause) {
    if (abort.aborted) throw cause
    throw unreachable_error(cause, api_key)
  }
}

/**
 * Map Brave's `web.results` to search results.
 *
 * Brave leaves `web` out altogether when a query has no web results, which is
 * an empty list. An entry with no string `url` is dropped.
 */
function to_results(body: Record<string, unknown>): ReadonlyArray<WebSearchResult> {
  const entries = as_record(body['web'])?.['results']
  if (!Array.isArray(entries)) return []
  const results: WebSearchResult[] = []
  for (const entry of entries) {
    const record = as_record(entry)
    const url = record?.['url']
    if (record === undefined || typeof url !== 'string' || url === '') continue
    const title = record['title']
    const description = record['description']
    results.push({
      title: typeof title === 'string' ? title : '',
      url,
      snippet: typeof description === 'string' ? description : '',
    })
  }
  return results
}

/**
 * Search through Brave's hosted index, with the key the app passes.
 *
 * The key is checked for presence when the factory is called, so a missing
 * one fails at startup and not on the model's first search.
 */
export function brave_search(config: BraveSearchConfig): WebSearch {
  const api_key = config.api_key
  if (api_key.trim() === '') {
    throw new Error("brave_search needs an api_key; pass the key for Brave's Search API")
  }
  return async (request, ctx) => {
    const answer = await send(search_url(request.query, request.limit), api_key, ctx.abort)
    if (!answer.ok) throw status_error(answer, api_key)
    const body = as_record(parse_json(answer.text))
    if (body === undefined) {
      throw new Error(
        `Brave search answered ${String(answer.status)} with a body that isn't its JSON search result`,
      )
    }
    return to_results(body)
  }
}
