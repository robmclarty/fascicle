import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecContext } from '#engine'
import { mcp_client } from '../client.js'
import { mcp_auth_required_error } from '../errors.js'
import { load_client_sdk } from '../sdk_loader.js'

// These tests cover the SDK-backed connect path that the InMemoryTransport
// suites in client.test.ts/round_trip.test.ts deliberately skip: building stdio
// and http transports, the client identity, and owning the connection lifecycle.
// The SDK loader is mocked so no process is spawned and no socket is opened.
vi.mock('../sdk_loader.js')

type CapturedTransport = { kind: 'stdio' | 'http'; args: unknown[] }
const captured: { transports: CapturedTransport[]; clients: FakeClient[] } = {
  transports: [],
  clients: [],
}

class FakeStdioTransport {
  constructor(public options: Record<string, unknown>) {
    captured.transports.push({ kind: 'stdio', args: [options] })
  }
}

class FakeHttpTransport {
  constructor(
    public url: URL,
    public options: Record<string, unknown>,
  ) {
    captured.transports.push({ kind: 'http', args: [url, options] })
  }
}

class FakeClient {
  closed = false
  connected_transport: unknown
  callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  constructor(public info: unknown) {
    captured.clients.push(this)
  }
  async connect(transport: unknown): Promise<void> {
    this.connected_transport = transport
  }
  async listTools(): Promise<{ tools: Array<Record<string, unknown>> }> {
    return { tools: [{ name: 'alpha', description: 'a', inputSchema: { type: 'object', properties: {} } }] }
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

class FakeUnauthorizedError extends Error {}

class FakeStreamableHTTPError extends Error {
  constructor(
    public code: number | undefined,
    message: string,
  ) {
    super(message)
  }
}

const fake_sdk = {
  Client: FakeClient,
  StdioClientTransport: FakeStdioTransport,
  StreamableHTTPClientTransport: FakeHttpTransport,
  StreamableHTTPError: FakeStreamableHTTPError,
  UnauthorizedError: FakeUnauthorizedError,
}

/** Swaps the fake SDK's Client for one whose `method` rejects with `failure`. */
function fail_client(method: 'connect' | 'listTools', failure: unknown): void {
  class FailingClient extends FakeClient {
    override async connect(transport: unknown): Promise<void> {
      if (method === 'connect') throw failure
      await super.connect(transport)
    }
    override async listTools(): Promise<{ tools: Array<Record<string, unknown>> }> {
      if (method === 'listTools') throw failure
      return super.listTools()
    }
  }
  vi.mocked(load_client_sdk).mockResolvedValue({ ...fake_sdk, Client: FailingClient } as never)
}

const HTTP = { transport: 'http', url: 'https://example.com/mcp' } as const

beforeEach(() => {
  captured.transports = []
  captured.clients = []
  vi.mocked(load_client_sdk).mockResolvedValue(fake_sdk as never)
})

afterEach(() => {
  vi.clearAllMocks()
})

function exec_ctx(signal: AbortSignal): ToolExecContext {
  return { abort: signal, tool_call_id: 'tc-1', step_index: 0 }
}

// Narrow away the `| undefined` that noUncheckedIndexedAccess adds, so the
// assertions can dereference captured records without optional chaining.
function sole<T>(items: readonly T[]): T {
  const [item] = items
  if (item === undefined) throw new Error('expected exactly one captured item')
  return item
}

describe('mcp_client connect path', () => {
  it('builds a stdio transport with every option and the default client identity', async () => {
    await mcp_client({ transport: 'stdio', command: 'srv', args: ['--x'], env: { A: '1' }, cwd: '/tmp' })
    const client = sole(captured.clients)
    expect(client.info).toEqual({ name: 'fascicle', version: '0.0.0' })
    expect(client.connected_transport).toBeInstanceOf(FakeStdioTransport)
    expect((client.connected_transport as FakeStdioTransport).options).toEqual({
      command: 'srv',
      args: ['--x'],
      env: { A: '1' },
      cwd: '/tmp',
    })
  })

  it('omits unset stdio options rather than passing undefined keys', async () => {
    await mcp_client({ transport: 'stdio', command: 'only' })
    const opts = sole(captured.transports).args[0] as Record<string, unknown>
    expect(opts).toEqual({ command: 'only' })
    expect('args' in opts).toBe(false)
    expect('env' in opts).toBe(false)
    expect('cwd' in opts).toBe(false)
  })

  it('builds an http transport carrying request headers', async () => {
    await mcp_client({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    })
    const transport = sole(captured.transports)
    expect(transport.kind).toBe('http')
    expect((transport.args[0] as URL).href).toBe('https://example.com/mcp')
    expect(transport.args[1]).toStrictEqual({ requestInit: { headers: { Authorization: 'Bearer t' } } })
  })

  it('builds an http transport with empty options when nothing but the url is given', async () => {
    await mcp_client(HTTP)
    expect(sole(captured.transports).args[1]).toStrictEqual({})
  })

  it('hands the auth provider to the transport as authProvider, and nothing else with it', async () => {
    const auth_provider = { tokens: () => undefined } as never
    await mcp_client({ ...HTTP, auth_provider })
    const opts = sole(captured.transports).args[1] as Record<string, unknown>
    expect(opts).toStrictEqual({ authProvider: auth_provider })
    expect(opts['authProvider']).toBe(auth_provider)
  })

  it('hands a custom fetch to the transport, and nothing else with it', async () => {
    const fetch_double = async (): Promise<Response> => new Response('')
    await mcp_client({ ...HTTP, fetch: fetch_double })
    const opts = sole(captured.transports).args[1] as Record<string, unknown>
    expect(opts).toStrictEqual({ fetch: fetch_double })
    expect(opts['fetch']).toBe(fetch_double)
  })

  it('hands a session id to the transport as sessionId, and nothing else with it', async () => {
    await mcp_client({ ...HTTP, session_id: 'sess-1' })
    expect(sole(captured.transports).args[1]).toStrictEqual({ sessionId: 'sess-1' })
  })

  it('hands the reconnection backoff to the transport under the SDK\'s names, and nothing else with it', async () => {
    await mcp_client({
      ...HTTP,
      reconnection: { max_retries: 5, initial_delay_ms: 250, max_delay_ms: 8000, delay_grow_factor: 2 },
    })
    expect(sole(captured.transports).args[1]).toStrictEqual({
      reconnectionOptions: {
        maxRetries: 5,
        initialReconnectionDelay: 250,
        maxReconnectionDelay: 8000,
        reconnectionDelayGrowFactor: 2,
      },
    })
  })

  it('forwards every http option together', async () => {
    const auth_provider = { tokens: () => undefined } as never
    const fetch_double = async (): Promise<Response> => new Response('')
    await mcp_client({
      ...HTTP,
      headers: { 'X-Trace': '1' },
      auth_provider,
      fetch: fetch_double,
      session_id: 'sess-2',
      reconnection: { max_retries: 1, initial_delay_ms: 10, max_delay_ms: 20, delay_grow_factor: 1.5 },
    })
    expect(sole(captured.transports).args[1]).toStrictEqual({
      requestInit: { headers: { 'X-Trace': '1' } },
      authProvider: auth_provider,
      fetch: fetch_double,
      sessionId: 'sess-2',
      reconnectionOptions: {
        maxRetries: 1,
        initialReconnectionDelay: 10,
        maxReconnectionDelay: 20,
        reconnectionDelayGrowFactor: 1.5,
      },
    })
  })

  it('passes a custom client identity through the handshake', async () => {
    await mcp_client({ transport: 'stdio', command: 'x' }, { client_info: { name: 'me', version: '9.9' } })
    expect(sole(captured.clients).info).toEqual({ name: 'me', version: '9.9' })
  })

  it('closes a client it owns', async () => {
    const handle = await mcp_client({ transport: 'stdio', command: 'x' })
    const client = sole(captured.clients)
    expect(client.closed).toBe(false)
    await handle.close()
    expect(client.closed).toBe(true)
  })

  it('closes a client it owns when listing its tools fails, then rethrows the failure', async () => {
    const failure = new Error('tools/list failed')
    class FailingListClient extends FakeClient {
      override async listTools(): Promise<never> {
        throw failure
      }
    }
    vi.mocked(load_client_sdk).mockResolvedValue({ ...fake_sdk, Client: FailingListClient } as never)
    await expect(mcp_client({ transport: 'stdio', command: 'x' })).rejects.toBe(failure)
    expect(sole(captured.clients).closed).toBe(true)
  })

  it('rethrows the listing failure even when closing the client fails too', async () => {
    const failure = new Error('tools/list failed')
    class FailingClient extends FakeClient {
      override async listTools(): Promise<never> {
        throw failure
      }
      override async close(): Promise<never> {
        throw new Error('close failed')
      }
    }
    vi.mocked(load_client_sdk).mockResolvedValue({ ...fake_sdk, Client: FailingClient } as never)
    await expect(mcp_client({ transport: 'stdio', command: 'x' })).rejects.toBe(failure)
  })

  it('leaves an injected client open when listing its tools fails', async () => {
    const failure = new Error('tools/list failed')
    const client = new FakeClient({ name: 'caller', version: '0.0.0' })
    client.listTools = async () => {
      throw failure
    }
    await expect(mcp_client({ transport: 'client', client: client as never })).rejects.toBe(failure)
    expect(client.closed).toBe(false)
  })

  it('forwards the tool name, arguments, and abort signal to callTool', async () => {
    const handle = await mcp_client({ transport: 'stdio', command: 'x' })
    const client = sole(captured.clients)
    const controller = new AbortController()
    await sole(handle.tools).execute({ q: 1 }, exec_ctx(controller.signal))
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'alpha', arguments: { q: 1 } },
      undefined,
      { signal: controller.signal },
    )
  })

  it('passes undefined arguments when the tool input is not a record', async () => {
    const handle = await mcp_client({ transport: 'stdio', command: 'x' })
    const client = sole(captured.clients)
    const controller = new AbortController()
    await sole(handle.tools).execute('scalar', exec_ctx(controller.signal))
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'alpha', arguments: undefined },
      undefined,
      { signal: controller.signal },
    )
  })

  it('throws a typed mcp_error and never calls the server when pre-aborted with a non-Error reason', async () => {
    const handle = await mcp_client({ transport: 'stdio', command: 'x' })
    const client = sole(captured.clients)
    const controller = new AbortController()
    controller.abort('shutting down')
    await expect(sole(handle.tools).execute({}, exec_ctx(controller.signal))).rejects.toMatchObject({
      kind: 'mcp_error',
      tool_name: 'alpha',
      message: 'MCP tool alpha aborted before invocation',
    })
    expect(client.callTool).not.toHaveBeenCalled()
  })

  describe('auth failures', () => {
    const MESSAGE =
      "MCP server at https://example.com/mcp requires authorization (Unauthorized): pass `auth_provider` in the http config with a token the server accepts, or finish an interactive OAuth flow on a transport of your own and pass its client as `transport: 'client'`"

    /** The rejection of `promise`, or a failure when it resolves. */
    async function rejection(promise: Promise<unknown>): Promise<unknown> {
      return promise.then(
        () => {
          throw new Error('expected a rejection')
        },
        (err: unknown) => err,
      )
    }

    it('turns an UnauthorizedError from an http connect into mcp_auth_required_error', async () => {
      const cause = new FakeUnauthorizedError('Unauthorized')
      fail_client('connect', cause)
      const err = await rejection(
        mcp_client({ transport: 'http', url: 'https://user:pw@example.com/mcp?token=secret#frag' }),
      )
      expect(err).toBeInstanceOf(mcp_auth_required_error)
      // The userinfo, the query, and the fragment stay out of the error.
      expect(err).toMatchObject({
        kind: 'mcp_auth_required_error',
        url: 'https://example.com/mcp',
        message: MESSAGE,
      })
      expect((err as Error).cause).toBe(cause)
    })

    it('turns a 401 StreamableHTTPError from an http connect into mcp_auth_required_error', async () => {
      const cause = new FakeStreamableHTTPError(401, 'Error POSTing to endpoint: denied')
      fail_client('connect', cause)
      const err = await rejection(mcp_client(HTTP))
      expect(err).toBeInstanceOf(mcp_auth_required_error)
      expect((err as Error).message).toContain('requires authorization (Error POSTing to endpoint: denied)')
      expect((err as Error).cause).toBe(cause)
    })

    it('leaves any other connect failure as the SDK threw it', async () => {
      for (const failure of [
        new FakeStreamableHTTPError(403, 'forbidden'),
        new FakeStreamableHTTPError(undefined, 'no status'),
        Object.assign(new Error('looks like one'), { code: 401 }),
        new Error('ECONNREFUSED'),
      ]) {
        fail_client('connect', failure)
        expect(await rejection(mcp_client(HTTP))).toBe(failure)
      }
    })

    it('leaves an UnauthorizedError from a stdio connect alone, since only http has an auth story', async () => {
      const failure = new FakeUnauthorizedError('Unauthorized')
      fail_client('connect', failure)
      expect(await rejection(mcp_client({ transport: 'stdio', command: 'x' }))).toBe(failure)
    })

    it('translates an auth failure from listing the tools, and still closes the client', async () => {
      const cause = new FakeUnauthorizedError('Unauthorized')
      fail_client('listTools', cause)
      const err = await rejection(mcp_client(HTTP))
      expect(err).toBeInstanceOf(mcp_auth_required_error)
      expect((err as Error).cause).toBe(cause)
      expect(sole(captured.clients).closed).toBe(true)
    })

    it('translates an auth failure from a tool call after the connect went through', async () => {
      const handle = await mcp_client(HTTP)
      const client = sole(captured.clients)
      const controller = new AbortController()

      const expired = new FakeUnauthorizedError('Unauthorized')
      client.callTool.mockRejectedValueOnce(expired)
      const err = await rejection(Promise.resolve(sole(handle.tools).execute({}, exec_ctx(controller.signal))))
      expect(err).toMatchObject({ kind: 'mcp_auth_required_error', url: 'https://example.com/mcp', message: MESSAGE })
      expect((err as Error).cause).toBe(expired)

      const other = new Error('socket hang up')
      client.callTool.mockRejectedValueOnce(other)
      expect(await rejection(Promise.resolve(sole(handle.tools).execute({}, exec_ctx(controller.signal))))).toBe(other)
    })

    it('leaves a tool call failure on a stdio connection as it was thrown', async () => {
      const handle = await mcp_client({ transport: 'stdio', command: 'x' })
      const failure = new FakeUnauthorizedError('Unauthorized')
      sole(captured.clients).callTool.mockRejectedValueOnce(failure)
      const call = Promise.resolve(sole(handle.tools).execute({}, exec_ctx(new AbortController().signal)))
      expect(await rejection(call)).toBe(failure)
    })

    it('never loads the SDK for an injected client, and leaves its errors as they are', async () => {
      const client = new FakeClient({ name: 'caller', version: '0.0.0' })
      const failure = new FakeUnauthorizedError('Unauthorized')
      client.callTool.mockRejectedValueOnce(failure)
      const handle = await mcp_client({ transport: 'client', client: client as never })
      const call = Promise.resolve(sole(handle.tools).execute({}, exec_ctx(new AbortController().signal)))
      expect(await rejection(call)).toBe(failure)
      expect(load_client_sdk).not.toHaveBeenCalled()
    })
  })
})
