import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import type { ToolExecContext } from '#engine'
import { mcp_client } from '../client.js'
import type { McpFetch } from '../client.js'
import { mcp_auth_required_error } from '../errors.js'

// Nothing here is mocked but the network: the real SDK loads, a real
// StreamableHTTPClientTransport is built, and the `fetch` option carries its
// requests to a function that answers as an MCP server would. That pins what
// the SDK really throws when a server answers 401, at connect and after it.

const URL_TEXT = 'https://mcp.example.com/mcp'

type Seen = { method: string; path: string; rpc: string | undefined; authorization: string | null }

type FakeServer = { fetch: McpFetch; seen: Seen[] }

/** The JSON text of a request the transport posted. */
function body_text(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON text body')
  return init.body
}

/**
 * A `fetch` that speaks enough Streamable HTTP for a handshake, a tool
 * listing, and a tool call. A JSON-RPC method named in `refuse` is answered
 * 401, and so is every OAuth discovery request, which the SDK takes to mean
 * the server publishes no metadata.
 */
function fake_server(refuse: ReadonlyArray<string>): FakeServer {
  const seen: Seen[] = []
  const fetch: McpFetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = new URL(String(url)).pathname
    const authorization = new Headers(init?.headers).get('authorization')
    if (method !== 'POST' || path !== '/mcp') {
      seen.push({ method, path, rpc: undefined, authorization })
      // 405 on the GET tells the transport this server opens no event stream.
      return new Response(null, { status: path === '/mcp' ? 405 : 404 })
    }
    const message = JSON.parse(body_text(init)) as {
      id?: number
      method: string
      params?: { protocolVersion?: string }
    }
    seen.push({ method, path, rpc: message.method, authorization })
    if (refuse.includes(message.method)) return new Response('token expired', { status: 401 })
    if (message.id === undefined) return new Response(null, { status: 202 })
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '0.0.0' },
      },
      'tools/list': { tools: [{ name: 'alpha', inputSchema: { type: 'object' } }] },
      'tools/call': { content: [{ type: 'text', text: 'ran' }] },
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: results[message.method] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, seen }
}

/**
 * An OAuth provider holding `token` and no refresh token, so a 401 leaves the
 * SDK nothing to do but send the user to authorize, which it reports as
 * `UnauthorizedError`.
 */
function provider(token: string | undefined): OAuthClientProvider & { redirects: URL[] } {
  const redirects: URL[] = []
  return {
    redirects,
    redirectUrl: 'https://app.example.com/callback',
    clientMetadata: { redirect_uris: ['https://app.example.com/callback'] },
    clientInformation: () => ({ client_id: 'client-1' }),
    tokens: () => (token !== undefined ? { access_token: token, token_type: 'Bearer' } : undefined),
    saveTokens: () => {},
    redirectToAuthorization: (url) => {
      redirects.push(url)
    },
    saveCodeVerifier: () => {},
    codeVerifier: () => 'verifier',
  }
}

function exec_ctx(): ToolExecContext {
  return { abort: new AbortController().signal, tool_call_id: 'tc-1', step_index: 0 }
}

/** The rejection of `promise`, or a failure when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (err: unknown) => err,
  )
}

describe('mcp_client auth against the real SDK transport', () => {
  it('connects through a custom fetch, sending the headers and the provider\'s token', async () => {
    const server = fake_server([])
    const handle = await mcp_client({
      transport: 'http',
      url: URL_TEXT,
      headers: { 'X-Trace': 'abc' },
      auth_provider: provider('tok-1'),
      fetch: server.fetch,
    })
    expect(handle.tools.map((t) => t.name)).toEqual(['alpha'])
    expect(await handle.tools[0]?.execute({}, exec_ctx())).toBe('ran')
    expect(server.seen.filter((s) => s.rpc !== undefined).map((s) => [s.rpc, s.authorization])).toEqual([
      ['initialize', 'Bearer tok-1'],
      ['notifications/initialized', 'Bearer tok-1'],
      ['tools/list', 'Bearer tok-1'],
      ['tools/call', 'Bearer tok-1'],
    ])
    await handle.close()
  })

  it('reports a 401 at connect with no provider, which the SDK throws as a StreamableHTTPError', async () => {
    const server = fake_server(['initialize'])
    const err = await rejection(mcp_client({ transport: 'http', url: `${URL_TEXT}?key=secret`, fetch: server.fetch }))
    expect(err).toBeInstanceOf(mcp_auth_required_error)
    expect(err).toMatchObject({ url: URL_TEXT })
    expect((err as Error).message).not.toContain('secret')
    const cause = (err as Error).cause
    expect(cause).toBeInstanceOf(StreamableHTTPError)
    expect((cause as StreamableHTTPError).code).toBe(401)
  })

  it('reports a 401 at connect with a provider that has no token, which the SDK throws as UnauthorizedError', async () => {
    const server = fake_server(['initialize'])
    const auth_provider = provider(undefined)
    const err = await rejection(mcp_client({ transport: 'http', url: URL_TEXT, auth_provider, fetch: server.fetch }))
    expect(err).toBeInstanceOf(mcp_auth_required_error)
    expect((err as Error).cause).toBeInstanceOf(UnauthorizedError)
    // The SDK got as far as sending the user to authorize, which this
    // connection has no way to finish.
    expect(auth_provider.redirects).toHaveLength(1)
  })

  it('reports a 401 on a tool call after a good connect, with a provider and without one', async () => {
    for (const auth_provider of [provider('tok-1'), undefined]) {
      const server = fake_server(['tools/call'])
      const handle = await mcp_client({
        transport: 'http',
        url: URL_TEXT,
        fetch: server.fetch,
        ...(auth_provider !== undefined ? { auth_provider } : {}),
      })
      const err = await rejection(Promise.resolve(handle.tools[0]?.execute({}, exec_ctx())))
      expect(err).toBeInstanceOf(mcp_auth_required_error)
      expect(err).toMatchObject({ kind: 'mcp_auth_required_error', url: URL_TEXT })
      expect((err as Error).cause).toBeInstanceOf(auth_provider !== undefined ? UnauthorizedError : StreamableHTTPError)
      await handle.close()
    }
  })

  it('leaves a 500 on a tool call as the SDK threw it', async () => {
    const server = fake_server([])
    const failing: McpFetch = async (url, init) => {
      if (body_text(init).includes('"tools/call"')) return new Response('boom', { status: 500 })
      return server.fetch(url, init)
    }
    const handle = await mcp_client({ transport: 'http', url: URL_TEXT, fetch: failing })
    const err = await rejection(Promise.resolve(handle.tools[0]?.execute({}, exec_ctx())))
    expect(err).toBeInstanceOf(StreamableHTTPError)
    expect((err as StreamableHTTPError).code).toBe(500)
    await handle.close()
  })
})
