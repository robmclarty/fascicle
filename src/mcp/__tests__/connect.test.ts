import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecContext } from '#engine'
import { mcp_client } from '../client.js'
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

const fake_sdk = {
  Client: FakeClient,
  StdioClientTransport: FakeStdioTransport,
  StreamableHTTPClientTransport: FakeHttpTransport,
}

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
    expect(transport.args[1]).toEqual({ requestInit: { headers: { Authorization: 'Bearer t' } } })
  })

  it('builds an http transport with empty options when no headers are given', async () => {
    await mcp_client({ transport: 'http', url: 'https://example.com/mcp' })
    expect(sole(captured.transports).args[1]).toEqual({})
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
})
