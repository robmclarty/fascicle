import { afterEach, describe, expect, it, vi } from 'vitest'
import { brave_search } from '../brave_search.js'

const KEY = 'BSA-secret-key-123'
const BASE = 'https://api.search.brave.com/res/v1/web/search'

const BAD_KEY_BODY = {
  error: {
    code: 'SUBSCRIPTION_TOKEN_INVALID',
    detail: 'The provided subscription token is invalid.',
    meta: { component: 'authentication' },
    status: 422,
  },
  type: 'ErrorResponse',
}

const RATE_LIMITED_BODY = {
  type: 'ErrorResponse',
  error: { code: 'RATE_LIMITED', detail: 'Request rate limit exceeded for plan.', status: 429 },
}

const VALIDATION_BODY = {
  error: { code: 'VALIDATION', detail: 'Unable to validate request parameter(s)', status: 422 },
  type: 'ErrorResponse',
}

type FetchMock = ReturnType<typeof stub_fetch>

function stub_fetch(result: Response | Error | (() => Promise<Response>)) {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    if (result instanceof Response) return result
    if (result instanceof Error) throw result
    return result()
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function json_response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ctx(): { abort: AbortSignal } {
  return { abort: new AbortController().signal }
}

function requested_url(mock: FetchMock): string {
  const input = mock.mock.calls[0]?.[0]
  return typeof input === 'string' ? input : ''
}

async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`rejected with a non-Error: ${String(error)}`, { cause: error })
  }
  throw new Error('expected a rejection')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('brave_search', () => {
  it('refuses an empty api_key when the factory is called', () => {
    const message = "brave_search needs an api_key; pass the key for Brave's Search API"
    expect(() => brave_search({ api_key: '' })).toThrow(new Error(message))
    expect(() => brave_search({ api_key: '   ' })).toThrow(new Error(message))
  })

  it('sends one GET with the exact URL, the key header, and the abort signal', async () => {
    const mock = stub_fetch(json_response({ web: { results: [] } }))
    const context = ctx()
    await brave_search({ api_key: KEY })({ query: 'tide tables & moons', limit: 8 }, context)

    expect(mock).toHaveBeenCalledTimes(1)
    expect(mock.mock.calls[0]?.[0]).toBe(
      `${BASE}?q=tide+tables+%26+moons&count=8&result_filter=web&text_decorations=false`,
    )
    const init = mock.mock.calls[0]?.[1]
    expect(init).toEqual({
      method: 'GET',
      headers: { 'X-Subscription-Token': KEY, Accept: 'application/json' },
      signal: context.abort,
    })
    expect(init?.signal).toBe(context.abort)
    expect(requested_url(mock)).not.toContain(KEY)
  })

  it.each([
    [1, '1'],
    [20, '20'],
    [21, '20'],
    [500, '20'],
    [0, '1'],
    [-3, '1'],
    [7.9, '7'],
  ])('holds a limit of %s to count=%s', async (limit, count) => {
    const mock = stub_fetch(json_response({}))
    await brave_search({ api_key: KEY })({ query: 'q', limit }, ctx())
    expect(new URL(requested_url(mock)).searchParams.get('count')).toBe(count)
  })

  it('maps web.results to title, url, and snippet', async () => {
    stub_fetch(
      json_response({
        type: 'search',
        query: { original: 'q' },
        web: {
          type: 'search',
          results: [
            { type: 'search_result', title: 'One', url: 'https://one.test/', description: 'first' },
            { title: 'Two', url: 'https://two.test/' },
            { title: 3, url: 'https://three.test/', description: 4 },
          ],
        },
      }),
    )
    const results = await brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx())
    expect(results).toEqual([
      { title: 'One', url: 'https://one.test/', snippet: 'first' },
      { title: 'Two', url: 'https://two.test/', snippet: '' },
      { title: '', url: 'https://three.test/', snippet: '' },
    ])
  })

  it('drops entries that have no string url', async () => {
    stub_fetch(
      json_response({
        web: {
          results: [
            { title: 'no url', description: 'x' },
            { title: 'number url', url: 7 },
            { title: 'empty url', url: '' },
            'not a record',
            null,
            { title: 'kept', url: 'https://kept.test/', description: 'y' },
          ],
        },
      }),
    )
    const results = await brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx())
    expect(results).toEqual([{ title: 'kept', url: 'https://kept.test/', snippet: 'y' }])
  })

  it.each([
    ['a missing web', { type: 'search', query: { original: 'q' } }],
    ['a web that is not an object', { web: 'none' }],
    ['a web with no results', { web: { type: 'search' } }],
    ['results that are not a list', { web: { results: { 0: { url: 'https://x.test/' } } } }],
  ])('returns an empty list for %s', async (_name, body) => {
    stub_fetch(json_response(body))
    await expect(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx())).resolves.toEqual([])
  })

  it('names a bad key by its 422 code and points at api_key', async () => {
    stub_fetch(json_response(BAD_KEY_BODY, 422))
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe(
      'Brave search answered 422 (SUBSCRIPTION_TOKEN_INVALID: The provided subscription token is invalid.); check the api_key passed to brave_search',
    )
    expect(error.message).not.toContain(KEY)
  })

  it('does not blame the key for a 422 with another code', async () => {
    stub_fetch(json_response(VALIDATION_BODY, 422))
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe(
      'Brave search answered 422 (VALIDATION: Unable to validate request parameter(s))',
    )
  })

  it.each([401, 403])('treats a %s as a key problem even with no envelope', async (status) => {
    stub_fetch(new Response('denied', { status }))
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe(
      `Brave search answered ${String(status)}; check the api_key passed to brave_search`,
    )
  })

  it('says to wait on a 429', async () => {
    stub_fetch(json_response(RATE_LIMITED_BODY, 429))
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe(
      'Brave search answered 429 (RATE_LIMITED: Request rate limit exceeded for plan.); the key is over its rate limit or its quota, so wait before searching again',
    )
  })

  it('says to wait on a 429 whose body is not JSON', async () => {
    stub_fetch(new Response('<html>Too Many Requests</html>', { status: 429 }))
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe(
      'Brave search answered 429; the key is over its rate limit or its quota, so wait before searching again',
    )
  })

  it('reports another status with its code and detail', async () => {
    stub_fetch(
      json_response({ type: 'ErrorResponse', error: { code: 'INTERNAL', detail: 'boom', status: 500 } }, 500),
    )
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe('Brave search answered 500 (INTERNAL: boom)')
  })

  it('reports a code alone when the envelope has no string detail', async () => {
    stub_fetch(json_response({ error: { code: 'INTERNAL', detail: 12 } }, 500))
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe('Brave search answered 500 (INTERNAL)')
  })

  it.each([
    ['a non-JSON body', '<html><h1>Bad Gateway</h1></html>'],
    ['a JSON body that is not the envelope', JSON.stringify({ message: 'nope' })],
    ['an envelope whose code is not a string', JSON.stringify({ error: { code: 5, detail: 'x' } })],
    ['an error that is not an object', JSON.stringify({ error: 'nope' })],
    ['a JSON body that is not an object', JSON.stringify(['nope'])],
  ])('falls back to the status alone for %s', async (_name, text) => {
    stub_fetch(new Response(text, { status: 502 }))
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe('Brave search answered 502')
  })

  it.each([
    ['is not JSON', '<html>hello</html>'],
    ['is JSON but not an object', '[1, 2]'],
    ['is empty', ''],
  ])('refuses a 200 whose body %s', async (_name, text) => {
    stub_fetch(new Response(text, { status: 200 }))
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe(
      "Brave search answered 200 with a body that isn't its JSON search result",
    )
  })

  it('wraps a fetch that rejects and keeps the cause', async () => {
    const cause = new TypeError('fetch failed')
    stub_fetch(cause)
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe('could not reach Brave search: fetch failed')
    expect(error.cause).toBe(cause)
  })

  it('wraps a rejection that is not an Error', async () => {
    const mock = vi.fn(async () => {
      throw 'socket hang up'
    })
    vi.stubGlobal('fetch', mock)
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe('could not reach Brave search: socket hang up')
    expect(error.cause).toBe('socket hang up')
  })

  it('wraps a body that fails part of the way through', async () => {
    const cause = new Error('terminated')
    const response = new Response('{}', { status: 200 })
    vi.spyOn(response, 'text').mockRejectedValue(cause)
    stub_fetch(response)
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe('could not reach Brave search: terminated')
    expect(error.cause).toBe(cause)
  })

  it('rethrows an abort unchanged', async () => {
    const controller = new AbortController()
    const reason = new Error('stopped by the caller')
    const mock = stub_fetch(async () => {
      controller.abort(reason)
      throw reason
    })
    const run = brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, { abort: controller.signal })
    await expect(run).rejects.toBe(reason)
    expect(mock.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
  })

  it('keeps the key out of a fetch error that quotes it, and drops that cause', async () => {
    stub_fetch(new TypeError(`Headers.append: "${KEY}" is an invalid header value.`))
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe(
      'could not reach Brave search: Headers.append: "[api_key]" is an invalid header value.',
    )
    expect(error.cause).toBeUndefined()
  })

  it.each([
    [422, { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: `token ${KEY} is invalid, ${KEY}` } }, 'Brave search answered 422 (SUBSCRIPTION_TOKEN_INVALID: token [api_key] is invalid, [api_key]); check the api_key passed to brave_search'],
    [429, { error: { code: 'RATE_LIMITED', detail: `slow down ${KEY}` } }, 'Brave search answered 429 (RATE_LIMITED: slow down [api_key]); the key is over its rate limit or its quota, so wait before searching again'],
    [500, { error: { code: 'INTERNAL', detail: `echo ${KEY}` } }, 'Brave search answered 500 (INTERNAL: echo [api_key])'],
  ])('keeps the key out of a %s message when the server echoes it', async (status, body, message) => {
    stub_fetch(json_response(body, status))
    const error = await failure(brave_search({ api_key: KEY })({ query: 'q', limit: 8 }, ctx()))
    expect(error.message).toBe(message)
    expect(error.message).not.toContain(KEY)
  })
})
