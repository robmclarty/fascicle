import { afterEach, describe, expect, it, vi } from 'vitest'
import { searxng_search } from '../searxng_search.js'

const BASE_URL = 'http://localhost:8888'

type FetchMock = ReturnType<typeof stub_fetch>

/**
 * Replaces the global `fetch` with a mock that answers with `result`, or
 * rejects with it when it is not a `Response`.
 */
function stub_fetch(result: unknown) {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    if (result instanceof Response) return result
    throw result
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/**
 * Builds a JSON response the way SearXNG sends one.
 */
function json_response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Builds the HTML response SearXNG sends for a status it has no JSON for.
 */
function html_response(status: number): Response {
  return new Response('<!doctype html><title>Nope</title>', {
    status,
    headers: { 'content-type': 'text/html' },
  })
}

/**
 * Builds `count` well-formed result entries, numbered from 1.
 */
function entries(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    title: `Title ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    content: `Snippet ${index + 1}`,
  }))
}

/**
 * Reads the URL the mock was called with on its first call.
 */
function requested_url(mock: FetchMock): unknown {
  return mock.mock.calls[0]?.[0]
}

/**
 * Runs one search with a signal that is never aborted.
 */
async function search(base_url: string, query = 'tide tables', limit = 8) {
  return searxng_search({ base_url })({ query, limit }, { abort: new AbortController().signal })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searxng_search', () => {
  it('sends one GET to /search with the query and format=json.', async () => {
    const mock = stub_fetch(json_response({ results: [] }))
    const abort = new AbortController().signal
    await searxng_search({ base_url: BASE_URL })({ query: 'tide tables & moon', limit: 8 }, { abort })
    expect(mock).toHaveBeenCalledTimes(1)
    expect(requested_url(mock)).toBe('http://localhost:8888/search?q=tide+tables+%26+moon&format=json')
    expect(mock.mock.calls[0]?.[1]).toEqual({
      headers: { Accept: 'application/json' },
      signal: abort,
    })
  })

  it('passes the abort signal it was given to fetch.', async () => {
    const mock = stub_fetch(json_response({ results: [] }))
    const controller = new AbortController()
    await searxng_search({ base_url: BASE_URL })({ query: 'q', limit: 1 }, { abort: controller.signal })
    expect(mock.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
  })

  it('tolerates a trailing slash on base_url.', async () => {
    const mock = stub_fetch(json_response({ results: [] }))
    await search('http://localhost:8888/', 'a')
    expect(requested_url(mock)).toBe('http://localhost:8888/search?q=a&format=json')
  })

  it('keeps a path prefix on base_url, with or without trailing slashes.', async () => {
    const bare = stub_fetch(json_response({ results: [] }))
    await search('https://search.example.com/searx/v1', 'a')
    expect(requested_url(bare)).toBe('https://search.example.com/searx/v1/search?q=a&format=json')
    const slashed = stub_fetch(json_response({ results: [] }))
    await search('https://search.example.com/searx/v1//', 'a')
    expect(requested_url(slashed)).toBe('https://search.example.com/searx/v1/search?q=a&format=json')
  })

  it('drops a query string and a fragment that base_url carries.', async () => {
    const mock = stub_fetch(json_response({ results: [] }))
    await search('http://localhost:8888/?theme=dark#top', 'a')
    expect(requested_url(mock)).toBe('http://localhost:8888/search?q=a&format=json')
  })

  it('refuses a base_url that is not a URL when the adapter is built.', () => {
    expect(() => searxng_search({ base_url: 'localhost:8888/x y' })).toThrow(
      new Error('searxng_search needs base_url as an http or https URL, and got "localhost:8888/x y"'),
    )
    expect(() => searxng_search({ base_url: '' })).toThrow(
      new Error('searxng_search needs base_url as an http or https URL, and got ""'),
    )
  })

  it('refuses a base_url on a scheme other than http or https.', () => {
    expect(() => searxng_search({ base_url: 'ftp://localhost:8888' })).toThrow(
      new Error('searxng_search needs base_url as an http or https URL, and got "ftp://localhost:8888"'),
    )
  })

  it('accepts both http and https.', () => {
    expect(typeof searxng_search({ base_url: 'http://localhost:8888' })).toBe('function')
    expect(typeof searxng_search({ base_url: 'https://search.example.com' })).toBe('function')
  })

  it('refuses a base_url with a username or a password, and keeps both out of the message.', () => {
    expect(() => searxng_search({ base_url: 'http://rob:hunter2@localhost:8888' })).toThrow(
      new Error('searxng_search needs base_url without a username or password, and got one for localhost:8888'),
    )
    expect(() => searxng_search({ base_url: 'http://rob@localhost:8888' })).toThrow(
      new Error('searxng_search needs base_url without a username or password, and got one for localhost:8888'),
    )
    expect(() => searxng_search({ base_url: 'http://:hunter2@localhost:8888' })).toThrow(
      new Error('searxng_search needs base_url without a username or password, and got one for localhost:8888'),
    )
  })

  it('maps title, url, and content to title, url, and snippet.', async () => {
    stub_fetch(
      json_response({
        query: 'tide tables',
        results: [
          { title: 'Tides', url: 'https://example.com/tides', content: 'High and low water.', engine: 'brave', score: 1 },
          { title: 'Moon', url: 'https://example.com/moon', content: 'Phases.' },
        ],
        unresponsive_engines: [],
      }),
    )
    expect(await search(BASE_URL)).toEqual([
      { title: 'Tides', url: 'https://example.com/tides', snippet: 'High and low water.' },
      { title: 'Moon', url: 'https://example.com/moon', snippet: 'Phases.' },
    ])
  })

  it("reads a missing or non-string title or content as ''.", async () => {
    stub_fetch(
      json_response({
        results: [
          { url: 'https://example.com/a' },
          { title: 7, url: 'https://example.com/b', content: null },
        ],
      }),
    )
    expect(await search(BASE_URL)).toEqual([
      { title: '', url: 'https://example.com/a', snippet: '' },
      { title: '', url: 'https://example.com/b', snippet: '' },
    ])
  })

  it('drops an entry with no url, and one that is not a record.', async () => {
    stub_fetch(
      json_response({
        results: [
          { title: 'No url', content: 'x' },
          { title: 'Null url', url: null, content: 'x' },
          { title: 'Empty url', url: '', content: 'x' },
          'a string',
          null,
          ['https://example.com/array'],
          { title: 'Kept', url: 'https://example.com/kept', content: 'y' },
        ],
      }),
    )
    expect(await search(BASE_URL)).toEqual([
      { title: 'Kept', url: 'https://example.com/kept', snippet: 'y' },
    ])
  })

  it('cuts the results to the limit.', async () => {
    stub_fetch(json_response({ results: entries(5) }))
    const found = await search(BASE_URL, 'q', 3)
    expect(found.map((result) => result.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ])
  })

  it('counts the limit over the entries it keeps, after the ones with no url are gone.', async () => {
    stub_fetch(json_response({ results: [{ title: 'No url' }, ...entries(3)] }))
    const found = await search(BASE_URL, 'q', 2)
    expect(found.map((result) => result.url)).toEqual(['https://example.com/1', 'https://example.com/2'])
  })

  it('returns 20 results for a limit of 20, and still 20 for a limit of 21.', async () => {
    stub_fetch(json_response({ results: entries(30) }))
    expect(await search(BASE_URL, 'q', 20)).toHaveLength(20)
    stub_fetch(json_response({ results: entries(30) }))
    expect(await search(BASE_URL, 'q', 21)).toHaveLength(20)
    stub_fetch(json_response({ results: entries(30) }))
    expect(await search(BASE_URL, 'q', 19)).toHaveLength(19)
  })

  it('returns an empty list when the server found nothing and every engine answered.', async () => {
    stub_fetch(json_response({ results: [], unresponsive_engines: [] }))
    expect(await search(BASE_URL)).toEqual([])
    stub_fetch(json_response({ results: [] }))
    expect(await search(BASE_URL)).toEqual([])
    stub_fetch(json_response({ results: [], unresponsive_engines: 'google' }))
    expect(await search(BASE_URL)).toEqual([])
  })

  it('names the engines that did not answer when the results are empty.', async () => {
    stub_fetch(
      json_response({
        results: [],
        unresponsive_engines: [['google', 'CAPTCHA'], ['duckduckgo', 'timeout'], 'bare', [7, 'x']],
      }),
    )
    await expect(search(BASE_URL)).rejects.toThrow(
      new Error('SearXNG at http://localhost:8888 found nothing because its engines did not answer (google, duckduckgo)'),
    )
  })

  it('returns the results it has when only some engines did not answer.', async () => {
    stub_fetch(json_response({ results: entries(1), unresponsive_engines: [['google', 'CAPTCHA']] }))
    expect(await search(BASE_URL)).toEqual([
      { title: 'Title 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
    ])
  })

  it('says to turn json on under search.formats when the server answers 403.', async () => {
    stub_fetch(html_response(403))
    await expect(search(BASE_URL)).rejects.toThrow(
      new Error(
        'SearXNG at http://localhost:8888 answered 403, most likely because json is not among its search.formats; add json under search.formats in settings.yml and restart the server',
      ),
    )
  })

  it('gives the 403 message whatever the body says, and never reads it.', async () => {
    const response = json_response({ error: 'something else' }, 403)
    stub_fetch(response)
    await expect(search(BASE_URL)).rejects.toThrow(
      new Error(
        'SearXNG at http://localhost:8888 answered 403, most likely because json is not among its search.formats; add json under search.formats in settings.yml and restart the server',
      ),
    )
    expect(response.bodyUsed).toBe(false)
  })

  it('repeats base_url in a message the way the caller wrote it.', async () => {
    stub_fetch(html_response(403))
    await expect(search('http://localhost:8888/searx/')).rejects.toThrow(
      /^SearXNG at http:\/\/localhost:8888\/searx\/ answered 403, /,
    )
  })

  it("names another status, with the server's error when the body carries one.", async () => {
    stub_fetch(json_response({ error: 'No query' }, 400))
    await expect(search(BASE_URL)).rejects.toThrow(
      new Error('SearXNG at http://localhost:8888 answered 400: No query'),
    )
    stub_fetch(json_response({ error: 'search error' }, 500))
    await expect(search(BASE_URL)).rejects.toThrow(
      new Error('SearXNG at http://localhost:8888 answered 500: search error'),
    )
  })

  it('names another status alone when the body carries no error string.', async () => {
    stub_fetch(html_response(429))
    await expect(search(BASE_URL)).rejects.toThrow(new Error('SearXNG at http://localhost:8888 answered 429'))
    stub_fetch(json_response({ error: { code: 7 } }, 502))
    await expect(search(BASE_URL)).rejects.toThrow(new Error('SearXNG at http://localhost:8888 answered 502'))
    stub_fetch(json_response({ results: entries(1) }, 500))
    await expect(search(BASE_URL)).rejects.toThrow(new Error('SearXNG at http://localhost:8888 answered 500'))
  })

  it('refuses a 200 whose body is not JSON.', async () => {
    stub_fetch(html_response(200))
    await expect(search(BASE_URL)).rejects.toThrow(
      new Error("SearXNG at http://localhost:8888 answered 200 with a body that isn't its JSON search result"),
    )
  })

  it('refuses a 200 whose JSON has no results array.', async () => {
    const message = "SearXNG at http://localhost:8888 answered 200 with a body that isn't its JSON search result"
    stub_fetch(json_response({ query: 'q' }))
    await expect(search(BASE_URL)).rejects.toThrow(new Error(message))
    stub_fetch(json_response({ results: { length: 0 } }))
    await expect(search(BASE_URL)).rejects.toThrow(new Error(message))
    stub_fetch(json_response(entries(2)))
    await expect(search(BASE_URL)).rejects.toThrow(new Error(message))
    stub_fetch(json_response(null))
    await expect(search(BASE_URL)).rejects.toThrow(new Error(message))
  })

  it('says the server could not be reached when fetch rejects, and keeps the cause.', async () => {
    const cause = new TypeError('fetch failed')
    stub_fetch(cause)
    const failure: unknown = await search(BASE_URL).catch((err: unknown) => err)
    expect(failure).toEqual(
      new Error(
        'could not reach SearXNG at http://localhost:8888: fetch failed; check that the server is running and base_url is right',
      ),
    )
    expect((failure as Error).cause).toBe(cause)
  })

  it('prints a rejection that is not an Error as it stands.', async () => {
    stub_fetch('socket hang up')
    const failure: unknown = await search(BASE_URL).catch((err: unknown) => err)
    expect(failure).toEqual(
      new Error(
        'could not reach SearXNG at http://localhost:8888: socket hang up; check that the server is running and base_url is right',
      ),
    )
    expect((failure as Error).cause).toBe('socket hang up')
  })

  it('rethrows an abort unchanged.', async () => {
    const controller = new AbortController()
    const reason = new DOMException('This operation was aborted', 'AbortError')
    stub_fetch(reason)
    controller.abort(reason)
    const failure: unknown = await searxng_search({ base_url: BASE_URL })(
      { query: 'q', limit: 1 },
      { abort: controller.signal },
    ).catch((err: unknown) => err)
    expect(failure).toBe(reason)
  })

  it('rethrows an abort that lands while the body is being read.', async () => {
    const controller = new AbortController()
    const reason = new DOMException('This operation was aborted', 'AbortError')
    const response = json_response({ results: entries(1) })
    vi.spyOn(response, 'json').mockImplementation(async () => {
      controller.abort(reason)
      throw reason
    })
    stub_fetch(response)
    const failure: unknown = await searxng_search({ base_url: BASE_URL })(
      { query: 'q', limit: 1 },
      { abort: controller.signal },
    ).catch((err: unknown) => err)
    expect(failure).toBe(reason)
  })
})
