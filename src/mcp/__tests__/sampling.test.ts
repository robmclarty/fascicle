import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  McpError,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TrajectoryLogger } from '#core'
import type { Engine, GenerateOptions, GenerateResult } from '#engine'
import { mcp_client } from '../client.js'
import { mcp_error } from '../errors.js'
import type { McpSamplingConfig, McpSamplingRequest } from '../sampling.js'
import { load_client_sdk } from '../sdk_loader.js'

// The loader hands back the real SDK with one substitution: the stdio
// transport is the client end of an in-memory pair whose other end a real
// McpServer holds. So `mcp_client` constructs the real Client itself (which is
// where the sampling capability is declared), and a real server asks it for
// completions over the wire.
vi.mock('../sdk_loader.js')

const open: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()))
  vi.clearAllMocks()
})

type Ask = Parameters<McpServer['server']['createMessage']>[0]

/** A server with one tool, so the handle's tool listing has something to list. */
function plain_server(): McpServer {
  const server = new McpServer({ name: 'sampler', version: '0.0.0' })
  server.registerTool('noop', {}, async () => ({ content: [] }))
  return server
}

/**
 * Connects `mcp_client` to a fresh server as a connection it owns, with
 * `sampling` as its option when given.
 */
async function connect_owned(sampling?: McpSamplingConfig): Promise<McpServer> {
  const server = plain_server()
  const [client_transport, server_transport] = InMemoryTransport.createLinkedPair()
  await server.connect(server_transport)
  // A constructor that returns an object hands that object to `new`.
  function LinkedTransport(): InMemoryTransport {
    return client_transport
  }
  vi.mocked(load_client_sdk).mockResolvedValue({
    Client,
    StdioClientTransport: LinkedTransport,
    StreamableHTTPClientTransport,
    StreamableHTTPError,
    UnauthorizedError,
    McpError,
    CreateMessageRequestSchema,
    ResourceUpdatedNotificationSchema,
    ResourceListChangedNotificationSchema,
  } as never)
  const handle = await mcp_client(
    { transport: 'stdio', command: 'unused' },
    sampling !== undefined ? { sampling } : {},
  )
  open.push(server, handle)
  return server
}

type StubEngine = { engine: Engine; calls: GenerateOptions[] }

/** An engine whose `generate` records its options and answers from `reply`. */
function stub_engine(reply: (opts: GenerateOptions) => Promise<Partial<GenerateResult>> | Partial<GenerateResult> = () => ({})): StubEngine {
  const calls: GenerateOptions[] = []
  const generate = async (opts: GenerateOptions): Promise<GenerateResult> => {
    calls.push(opts)
    return {
      content: 'pong',
      tool_calls: [],
      steps: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      finish_reason: 'stop',
      model_resolved: { provider: 'stub', model_id: 'resolved-model' },
      ...(await reply(opts)),
    }
  }
  return { engine: { generate } as unknown as Engine, calls }
}

const HELLO: Ask = { messages: [{ role: 'user', content: { type: 'text', text: 'ping' } }], maxTokens: 100 }

/** The rejection of `promise`, or a failure when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (err: unknown) => err,
  )
}

describe('mcp_client sampling', () => {
  it('answers a server\'s createMessage through the engine, with the configured model', async () => {
    const { engine, calls } = stub_engine()
    const server = await connect_owned({ engine, model: 'cfg-model' })

    const result = await server.server.createMessage({
      messages: [
        { role: 'user', content: { type: 'text', text: 'ping' } },
        { role: 'assistant', content: { type: 'text', text: 'pong?' } },
        { role: 'user', content: { type: 'text', text: 'again' } },
      ],
      systemPrompt: 'be brief',
      maxTokens: 100,
      temperature: 0.2,
      // Asked for, and dropped: neither reaches the engine.
      stopSequences: ['STOP'],
      modelPreferences: { hints: [{ name: 'some-other-model' }], speedPriority: 1 },
    })

    expect(result).toStrictEqual({
      model: 'resolved-model',
      role: 'assistant',
      content: { type: 'text', text: 'pong' },
      stopReason: 'endTurn',
    })
    expect(calls).toStrictEqual([
      {
        model: 'cfg-model',
        prompt: [
          { role: 'user', content: 'ping' },
          { role: 'assistant', content: 'pong?' },
          { role: 'user', content: 'again' },
        ],
        system: 'be brief',
        max_tokens: 100,
        temperature: 0.2,
        abort: expect.any(AbortSignal),
      },
    ])
  })

  it('leaves out of the generate call what neither the request nor the config set', async () => {
    const { engine, calls } = stub_engine()
    const server = await connect_owned({ engine, model: 'cfg-model' })
    await server.server.createMessage(HELLO)
    expect(calls).toStrictEqual([
      { model: 'cfg-model', prompt: [{ role: 'user', content: 'ping' }], max_tokens: 100, abort: expect.any(AbortSignal) },
    ])
  })

  it('passes the configured provider and trajectory to the engine', async () => {
    const { engine, calls } = stub_engine()
    const trajectory: TrajectoryLogger = { record: () => {}, start_span: () => 's', end_span: () => {} }
    const server = await connect_owned({ engine, model: 'cfg-model', provider: 'ollama', trajectory })
    await server.server.createMessage(HELLO)
    expect(calls[0]?.provider).toBe('ollama')
    expect(calls[0]?.trajectory).toBe(trajectory)
  })

  it('caps the request\'s maxTokens at the config\'s max_tokens, and never raises it', async () => {
    const { engine, calls } = stub_engine()
    const server = await connect_owned({ engine, model: 'm', max_tokens: 50 })
    await server.server.createMessage({ ...HELLO, maxTokens: 100 })
    await server.server.createMessage({ ...HELLO, maxTokens: 20 })
    await server.server.createMessage({ ...HELLO, maxTokens: 50 })
    expect(calls.map((c) => c.max_tokens)).toEqual([50, 20, 50])
  })

  it('maps the engine\'s finish reason to stopReason, and passes on one MCP has no name for', async () => {
    const reasons: Array<GenerateResult['finish_reason']> = ['stop', 'length', 'content_filter']
    const { engine } = stub_engine(() => ({ finish_reason: reasons.shift() ?? 'stop' }))
    const server = await connect_owned({ engine, model: 'm' })
    const stops: Array<string | undefined> = []
    for (let i = 0; i < 3; i += 1) stops.push((await server.server.createMessage(HELLO)).stopReason)
    expect(stops).toEqual(['endTurn', 'maxTokens', 'content_filter'])
  })

  it('threads the server\'s cancellation into the generate call\'s abort signal', async () => {
    let started: (() => void) | undefined
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const aborted: boolean[] = []
    const { engine } = stub_engine(
      (opts) =>
        new Promise((resolve) => {
          opts.abort?.addEventListener('abort', () => {
            aborted.push(opts.abort?.aborted === true)
            resolve({})
          })
          started?.()
        }),
    )
    const server = await connect_owned({ engine, model: 'm' })
    // The SDK drops a cancellation for request id 0, which a server's first
    // request carries, so a ping takes that id first.
    await server.server.ping()
    const controller = new AbortController()
    const asked = rejection(server.server.createMessage(HELLO, { signal: controller.signal }))
    await running
    controller.abort(new Error('server gave up'))
    await asked
    await vi.waitFor(() => expect(aborted).toEqual([true]))
  })

  it('answers the server with the engine\'s own message when the completion fails', async () => {
    const { engine } = stub_engine(() => {
      throw new Error('provider is down')
    })
    const server = await connect_owned({ engine, model: 'm' })
    const err = await rejection(server.server.createMessage(HELLO))
    expect((err as Error).message).toContain('provider is down')
  })
})

describe('mcp_client sampling capability', () => {
  it('declares sampling, and nothing under it, when the option is set', async () => {
    const server = await connect_owned({ engine: stub_engine().engine, model: 'm' })
    expect(server.server.getClientCapabilities()).toStrictEqual({ sampling: {} })
  })

  it('declares no capability and serves no sampling when the option is unset', async () => {
    const server = await connect_owned()
    expect(server.server.getClientCapabilities()).toStrictEqual({})
    const err = await rejection(server.server.createMessage(HELLO))
    expect((err as Error).message).toContain('Method not found')
  })

  it('leaves the tools variant unadvertised, so an SDK server refuses to send it', async () => {
    const { engine, calls } = stub_engine()
    const server = await connect_owned({ engine, model: 'm' })
    const err = await rejection(
      server.server.createMessage({ ...HELLO, tools: [{ name: 't', inputSchema: { type: 'object' } }] }),
    )
    expect((err as Error).message).toBe('Client does not support sampling tools capability.')
    expect(calls).toEqual([])
  })

  it('refuses a request that carries tools or a tool choice anyway, before the engine is called', async () => {
    const { engine, calls } = stub_engine()
    const server = await connect_owned({ engine, model: 'm' })
    // `request` skips the server-side check `createMessage` makes, the way a
    // server not built on this SDK would.
    for (const extra of [
      { tools: [{ name: 't', inputSchema: { type: 'object' } }] },
      { toolChoice: { mode: 'auto' } },
    ]) {
      const err = await rejection(
        server.server.request(
          { method: 'sampling/createMessage', params: { ...HELLO, ...extra } },
          CreateMessageResultSchema,
        ),
      )
      expect(err).toBeInstanceOf(McpError)
      expect((err as McpError).code).toBe(-32602)
      expect((err as Error).message).toContain(
        'sampling with tools is not supported by this client: send the request without `tools` and `toolChoice`',
      )
    }
    expect(calls).toEqual([])
  })
})

describe('mcp_client sampling on_request', () => {
  it('shows the hook the request in Fascicle shapes, with the capped max_tokens and the raw preferences', async () => {
    const seen: McpSamplingRequest[] = []
    const { engine, calls } = stub_engine()
    const server = await connect_owned({
      engine,
      model: 'm',
      max_tokens: 40,
      on_request: (request) => {
        seen.push(request)
        return true
      },
    })
    const preferences = { hints: [{ name: 'fast-one' }], costPriority: 0.5 }
    await server.server.createMessage({ ...HELLO, systemPrompt: 'be brief', modelPreferences: preferences })
    await server.server.createMessage(HELLO)

    expect(seen).toStrictEqual([
      {
        messages: [{ role: 'user', content: 'ping' }],
        system: 'be brief',
        max_tokens: 40,
        model_preferences: preferences,
      },
      { messages: [{ role: 'user', content: 'ping' }], max_tokens: 40 },
    ])
    expect(calls).toHaveLength(2)
  })

  it('refuses the request before the engine is called when the hook answers false', async () => {
    for (const on_request of [() => false, async () => false, () => undefined as unknown as boolean]) {
      const { engine, calls } = stub_engine()
      const server = await connect_owned({ engine, model: 'm', on_request })
      const err = await rejection(server.server.createMessage(HELLO))
      expect(err).toBeInstanceOf(McpError)
      expect((err as McpError).code).toBe(-1)
      expect((err as Error).message).toContain('sampling request rejected by the client')
      expect(calls).toEqual([])
    }
  })

  it('goes on to the engine when the hook answers true, sync or async', async () => {
    for (const on_request of [() => true, async () => true]) {
      const { engine, calls } = stub_engine()
      const server = await connect_owned({ engine, model: 'm', on_request })
      expect((await server.server.createMessage(HELLO)).content).toEqual({ type: 'text', text: 'pong' })
      expect(calls).toHaveLength(1)
    }
  })
})

describe('mcp_client sampling message mapping', () => {
  it('maps a multi-block user message to parts, images included, and a multi-block assistant message to text parts', async () => {
    const { engine, calls } = stub_engine()
    const server = await connect_owned({ engine, model: 'm' })
    await server.server.createMessage({
      maxTokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', data: 'AAEC', mimeType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'one block in an array' }] },
        { role: 'user', content: { type: 'image', data: 'AQID', mimeType: 'image/jpeg' } },
      ],
    })
    expect(calls[0]?.prompt).toStrictEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', image: 'AAEC', media_type: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
      { role: 'user', content: 'one block in an array' },
      { role: 'user', content: [{ type: 'image', image: 'AQID', media_type: 'image/jpeg' }] },
    ])
  })

  it('refuses content it has no engine shape for, naming the type and the role', async () => {
    const { engine, calls } = stub_engine()
    const server = await connect_owned({ engine, model: 'm' })
    const cases: Array<[Ask['messages'][number], string]> = [
      [
        { role: 'user', content: { type: 'audio', data: 'AAEC', mimeType: 'audio/wav' } },
        "sampling content of type 'audio' in a user message is not supported by this client: send text, or an image in a user message",
      ],
      [
        { role: 'assistant', content: { type: 'image', data: 'AAEC', mimeType: 'image/png' } },
        "sampling content of type 'image' in a assistant message is not supported by this client: send text, or an image in a user message",
      ],
    ]
    for (const [message, text] of cases) {
      const err = await rejection(server.server.createMessage({ maxTokens: 10, messages: [message] }))
      expect(err).toBeInstanceOf(McpError)
      expect((err as McpError).code).toBe(-32602)
      expect((err as Error).message).toContain(text)
    }
    expect(calls).toEqual([])
  })
})

describe('mcp_client sampling on a client the caller connected', () => {
  /** Links a caller-built client, constructed with `capabilities`, to a fresh server. */
  async function connect_injected(capabilities: Record<string, object>): Promise<{ server: McpServer; client: Client }> {
    const actual = await vi.importActual<typeof import('../sdk_loader.js')>('../sdk_loader.js')
    vi.mocked(load_client_sdk).mockImplementation(actual.load_client_sdk)
    const server = plain_server()
    const [client_transport, server_transport] = InMemoryTransport.createLinkedPair()
    await server.connect(server_transport)
    const client = new Client({ name: 'caller', version: '0.0.0' }, { capabilities })
    await client.connect(client_transport)
    open.push(server, client)
    return { server, client }
  }

  it('serves sampling when that client declared the capability', async () => {
    const { server, client } = await connect_injected({ sampling: {} })
    const { engine, calls } = stub_engine()
    await mcp_client({ transport: 'client', client }, { sampling: { engine, model: 'cfg-model' } })
    const result = await server.server.createMessage(HELLO)
    expect(result.content).toEqual({ type: 'text', text: 'pong' })
    expect(calls.map((c) => c.model)).toEqual(['cfg-model'])
  })

  it('says how to fix a client that declared no sampling capability', async () => {
    const { client } = await connect_injected({})
    const err = await rejection(
      mcp_client({ transport: 'client', client }, { sampling: { engine: stub_engine().engine, model: 'm' } }),
    )
    expect(err).toBeInstanceOf(mcp_error)
    expect((err as Error).message).toBe(
      "sampling can't be served on the client passed as `transport: 'client'` (Client does not support sampling capability (required for sampling/createMessage)): construct that Client with `capabilities: { sampling: {} }`, or drop the `sampling` option",
    )
  })

  it('spells out a registration failure that is not an Error', async () => {
    await connect_injected({})
    const client = {
      setRequestHandler: () => {
        throw 'refused by a double'
      },
    }
    const err = await rejection(
      mcp_client(
        { transport: 'client', client: client as never },
        { sampling: { engine: stub_engine().engine, model: 'm' } },
      ),
    )
    expect(err).toBeInstanceOf(mcp_error)
    expect((err as Error).message).toContain("`transport: 'client'` (refused by a double): construct that Client")
  })

  it('loads no SDK for that client when sampling is unset', async () => {
    const { client } = await connect_injected({})
    vi.mocked(load_client_sdk).mockClear()
    await mcp_client({ transport: 'client', client })
    expect(load_client_sdk).not.toHaveBeenCalled()
  })
})
