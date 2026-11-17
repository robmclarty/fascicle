import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcp_client } from '../client.js'
import { mcp_error } from '../errors.js'
import { create_resources } from '../resources.js'
import type { McpResources } from '../resources.js'

const open: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()))
  vi.restoreAllMocks()
})

const README = 'file:///readme.md'
const LOGO = 'file:///logo.png'

type Wire = { subscribed: string[]; unsubscribed: string[] }

type Published = { server: McpServer; wire: Wire }

/**
 * A server publishing a described text resource, a bare binary one, and two
 * templates, which advertises `subscribe` and records each subscription
 * request it is sent. A subscribe to a URI in `refuse` is answered with an
 * error.
 */
function publishing_server(refuse: ReadonlyArray<string> = []): Published {
  const wire: Wire = { subscribed: [], unsubscribed: [] }
  const server = new McpServer(
    { name: 'publisher', version: '0.0.0' },
    { capabilities: { resources: { subscribe: true, listChanged: true } } },
  )
  server.registerResource(
    'readme',
    README,
    { description: 'The readme', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# hi' }] }),
  )
  server.registerResource('logo', LOGO, {}, async (uri) => ({ contents: [{ uri: uri.href, blob: 'AAEC' }] }))
  server.registerResource(
    'doc',
    new ResourceTemplate('doc:///{id}', { list: undefined }),
    { description: 'A doc by id', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, text: 'doc' }] }),
  )
  server.registerResource('raw', new ResourceTemplate('raw:///{id}', { list: undefined }), {}, async (uri) => ({
    contents: [{ uri: uri.href, text: 'raw' }],
  }))
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    wire.subscribed.push(request.params.uri)
    if (refuse.includes(request.params.uri)) throw new Error('no such resource')
    return {}
  })
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    wire.unsubscribed.push(request.params.uri)
    return {}
  })
  return { server, wire }
}

async function connect(server: McpServer | Server): Promise<Client> {
  const [client_transport, server_transport] = InMemoryTransport.createLinkedPair()
  await server.connect(server_transport)
  const client = new Client({ name: 'resources-test', version: '0.0.0' })
  await client.connect(client_transport)
  open.push(server, client)
  return client
}

/** The `resources` namespace `mcp_client` builds over `client`. */
async function resources_over(client: Client): Promise<McpResources> {
  const handle = await mcp_client({ transport: 'client', client })
  return handle.resources
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

describe('mcp_client resources: list, templates, read', () => {
  it('lists resources under Fascicle names, leaving out what the server left out', async () => {
    const resources = await resources_over(await connect(publishing_server().server))
    expect(await resources.list()).toStrictEqual([
      { uri: README, name: 'readme', description: 'The readme', mime_type: 'text/markdown' },
      { uri: LOGO, name: 'logo' },
    ])
  })

  it('lists resource templates under Fascicle names, leaving out what the server left out', async () => {
    const resources = await resources_over(await connect(publishing_server().server))
    expect(await resources.templates()).toStrictEqual([
      { uri_template: 'doc:///{id}', name: 'doc', description: 'A doc by id', mime_type: 'text/plain' },
      { uri_template: 'raw:///{id}', name: 'raw' },
    ])
  })

  it('reads text content with its mime type and binary content as a blob', async () => {
    const resources = await resources_over(await connect(publishing_server().server))
    expect(await resources.read(README)).toStrictEqual([{ uri: README, mime_type: 'text/markdown', text: '# hi' }])
    expect(await resources.read(LOGO)).toStrictEqual([{ uri: LOGO, blob: 'AAEC' }])
    expect(await resources.read('doc:///7')).toStrictEqual([{ uri: 'doc:///7', text: 'doc' }])
  })

  it('follows the cursor through every page of both listings', async () => {
    const cursors: Array<[string, string | undefined]> = []
    const server = new Server({ name: 'paged', version: '0.0.0' }, { capabilities: { resources: {} } })
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      const cursor = request.params?.cursor
      cursors.push(['resources', cursor])
      if (cursor === undefined) return { resources: [{ uri: 'a:///1', name: 'one' }], nextCursor: 'page-2' }
      if (cursor === 'page-2') return { resources: [{ uri: 'a:///2', name: 'two' }], nextCursor: 'page-3' }
      return { resources: [{ uri: 'a:///3', name: 'three' }] }
    })
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      const cursor = request.params?.cursor
      cursors.push(['templates', cursor])
      if (cursor === undefined) return { resourceTemplates: [{ uriTemplate: 't:///{a}', name: 'ta' }], nextCursor: 'more' }
      return { resourceTemplates: [{ uriTemplate: 't:///{b}', name: 'tb' }] }
    })
    const resources = create_resources(await connect(server), (err) => err)

    expect((await resources.list()).map((r) => r.name)).toEqual(['one', 'two', 'three'])
    expect((await resources.templates()).map((t) => t.uri_template)).toEqual(['t:///{a}', 't:///{b}'])
    expect(cursors).toEqual([
      ['resources', undefined],
      ['resources', 'page-2'],
      ['resources', 'page-3'],
      ['templates', undefined],
      ['templates', 'more'],
    ])
  })
})

describe('mcp_client over a server that only publishes resources', () => {
  it('surfaces no tools without asking for any, and still reads the resources', async () => {
    const client = await connect(publishing_server().server)
    const list_tools = vi.spyOn(client, 'listTools')
    const handle = await mcp_client({ transport: 'client', client })
    expect(handle.tools).toEqual([])
    expect(list_tools).not.toHaveBeenCalled()
    expect((await handle.resources.list()).map((r) => r.name)).toEqual(['readme', 'logo'])
  })
})

describe('mcp_client resources: subscriptions', () => {
  it('delivers an update to exactly the callbacks on that URI, over one subscription a URI', async () => {
    const { server, wire } = publishing_server()
    const resources = await resources_over(await connect(server))
    const first = vi.fn()
    const second = vi.fn()
    const other = vi.fn()
    await resources.subscribe(README, first)
    await resources.subscribe(README, second)
    await resources.subscribe(LOGO, other)
    expect(wire.subscribed).toEqual([README, LOGO])

    await server.server.sendResourceUpdated({ uri: README })
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1))
    expect(first.mock.calls).toEqual([[README]])
    expect(second.mock.calls).toEqual([[README]])
    expect(other).not.toHaveBeenCalled()
  })

  it('stops delivering after unsubscribe, and tells the server once', async () => {
    const { server, wire } = publishing_server()
    const resources = await resources_over(await connect(server))
    const dropped = vi.fn()
    const kept = vi.fn()
    await resources.subscribe(README, dropped)
    await resources.subscribe(LOGO, kept)

    await resources.unsubscribe(README)
    // Nothing is left on the URI, so a second call sends nothing, and neither
    // does a URI that was never subscribed.
    await resources.unsubscribe(README)
    await resources.unsubscribe('file:///never.md')
    expect(wire.unsubscribed).toEqual([README])

    await server.server.sendResourceUpdated({ uri: README })
    await server.server.sendResourceUpdated({ uri: LOGO })
    await vi.waitFor(() => expect(kept).toHaveBeenCalledTimes(1))
    expect(dropped).not.toHaveBeenCalled()
  })

  it('subscribes on the server again after an unsubscribe', async () => {
    const { server, wire } = publishing_server()
    const resources = await resources_over(await connect(server))
    await resources.subscribe(README, vi.fn())
    await resources.unsubscribe(README)
    const again = vi.fn()
    await resources.subscribe(README, again)
    expect(wire.subscribed).toEqual([README, README])

    await server.server.sendResourceUpdated({ uri: README })
    await vi.waitFor(() => expect(again).toHaveBeenCalledTimes(1))
  })

  it('registers nothing on the client until something subscribes, then each handler once', async () => {
    const { server } = publishing_server()
    const client = await connect(server)
    const register = vi.spyOn(client, 'setNotificationHandler')
    const resources = await resources_over(client)
    await resources.list()
    await resources.templates()
    await resources.read(README)
    expect(register).not.toHaveBeenCalled()

    await resources.subscribe(README, vi.fn())
    await resources.subscribe(LOGO, vi.fn())
    expect(register.mock.calls.map(([schema]) => schema)).toEqual([ResourceUpdatedNotificationSchema])

    await resources.on_list_changed(vi.fn())
    await resources.on_list_changed(vi.fn())
    expect(register.mock.calls.map(([schema]) => schema)).toEqual([
      ResourceUpdatedNotificationSchema,
      ResourceListChangedNotificationSchema,
    ])
  })

  it('calls every list-changed listener when the server says its listing changed', async () => {
    const { server } = publishing_server()
    const resources = await resources_over(await connect(server))
    const first = vi.fn()
    const second = vi.fn()
    await resources.on_list_changed(first)
    await resources.on_list_changed(second)

    server.sendResourceListChanged()
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1))
    expect(first.mock.calls).toEqual([[]])
    expect(second.mock.calls).toEqual([[]])
  })

  it('ignores an update for a URI nobody subscribed to', async () => {
    const { server } = publishing_server()
    const client = await connect(server)
    const onerror = vi.fn()
    Object.assign(client, { onerror })
    const resources = await resources_over(client)
    const heard = vi.fn()
    await resources.subscribe(README, heard)

    await server.server.sendResourceUpdated({ uri: 'file:///elsewhere.md' })
    await server.server.sendResourceUpdated({ uri: README })
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1))
    expect(onerror).not.toHaveBeenCalled()
  })

  it('still calls the other callbacks when one throws, and hands the first failure to onerror', async () => {
    const { server } = publishing_server()
    const client = await connect(server)
    const onerror = vi.fn()
    Object.assign(client, { onerror })
    const resources = await resources_over(client)
    const after = vi.fn()
    await resources.subscribe(README, () => {
      throw new Error('first subscriber broke')
    })
    await resources.subscribe(README, () => {
      throw new Error('second subscriber broke')
    })
    await resources.subscribe(README, after)

    await server.server.sendResourceUpdated({ uri: README })
    await vi.waitFor(() => expect(onerror).toHaveBeenCalledTimes(1))
    expect(after).toHaveBeenCalledTimes(1)
    const reported = onerror.mock.calls[0]?.[0] as Error
    expect(reported.message).toContain('first subscriber broke')
    expect(reported.message).not.toContain('second subscriber broke')
  })

  it('rejects every subscriber waiting on a refused subscription, and forgets the URI', async () => {
    const { server, wire } = publishing_server([README])
    const resources = await resources_over(await connect(server))
    const settled = await Promise.allSettled([resources.subscribe(README, vi.fn()), resources.subscribe(README, vi.fn())])
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected'])
    expect(wire.subscribed).toEqual([README])

    // The URI was forgotten, so the next subscribe asks the server again
    // and an unsubscribe has nothing to end.
    await rejection(resources.subscribe(README, vi.fn()))
    expect(wire.subscribed).toEqual([README, README])
    await resources.unsubscribe(README)
    expect(wire.unsubscribed).toEqual([])
  })

  it('keeps a newer subscription when an older request on the same URI fails late', async () => {
    const { server } = publishing_server()
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const arrived: string[] = []
    // The first subscribe request hangs until released and then fails; the
    // second is answered at once.
    server.server.setRequestHandler(SubscribeRequestSchema, async () => {
      arrived.push('subscribe')
      if (arrived.length > 1) return {}
      await held
      throw new Error('late failure')
    })
    const resources = await resources_over(await connect(server))

    const stale = rejection(resources.subscribe(README, vi.fn()))
    await vi.waitFor(() => expect(arrived).toHaveLength(1))
    await resources.unsubscribe(README)
    const fresh = vi.fn()
    await resources.subscribe(README, fresh)
    release?.()
    expect(await stale).toMatchObject({ message: expect.stringContaining('late failure') })

    await server.server.sendResourceUpdated({ uri: README })
    await vi.waitFor(() => expect(fresh).toHaveBeenCalledTimes(1))
  })
})

describe('mcp_client resources: capabilities', () => {
  const NO_RESOURCES = (action: string): string =>
    `MCP server does not advertise the \`resources\` capability, so ${action} has nothing to ask it: connect to a server that lists \`resources\` among its capabilities`

  it('refuses every call, before any request, on a server that advertises no resources', async () => {
    const server = new McpServer({ name: 'tools-only', version: '0.0.0' })
    server.registerTool('noop', {}, async () => ({ content: [] }))
    const client = await connect(server)
    const sent = vi.spyOn(client, 'request')
    const register = vi.spyOn(client, 'setNotificationHandler')
    const resources = await resources_over(client)
    sent.mockClear()

    const refused: Array<[string, Promise<unknown>]> = [
      ['resources.list', resources.list()],
      ['resources.templates', resources.templates()],
      ['resources.read', resources.read(README)],
      ['resources.subscribe', resources.subscribe(README, vi.fn())],
      ['resources.on_list_changed', resources.on_list_changed(vi.fn())],
    ]
    for (const [action, call] of refused) {
      const err = await rejection(call)
      expect(err).toBeInstanceOf(mcp_error)
      expect((err as Error).message).toBe(NO_RESOURCES(action))
    }
    expect(sent).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })

  it('refuses subscribe on a server that publishes resources without subscriptions', async () => {
    // An McpServer with a resource advertises `listChanged` and nothing more.
    const server = new McpServer({ name: 'no-subscribe', version: '0.0.0' })
    server.registerResource('readme', README, {}, async (uri) => ({ contents: [{ uri: uri.href, text: 'hi' }] }))
    const client = await connect(server)
    const register = vi.spyOn(client, 'setNotificationHandler')
    const resources = await resources_over(client)

    const err = await rejection(resources.subscribe(README, vi.fn()))
    expect(err).toBeInstanceOf(mcp_error)
    expect((err as Error).message).toBe(
      'MCP server does not advertise the `resources.subscribe` capability, so resources.subscribe would never hear from it: call resources.read when you need the current content',
    )
    expect(register).not.toHaveBeenCalled()

    // What it does advertise still works.
    expect((await resources.list()).map((r) => r.name)).toEqual(['readme'])
    await resources.on_list_changed(vi.fn())
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('refuses on_list_changed on a server that never announces a changed listing', async () => {
    const server = new Server(
      { name: 'no-list-changed', version: '0.0.0' },
      { capabilities: { resources: { subscribe: true, listChanged: false } } },
    )
    server.setRequestHandler(SubscribeRequestSchema, async () => ({}))
    const resources = await resources_over_bare(server)

    const err = await rejection(resources.on_list_changed(vi.fn()))
    expect(err).toBeInstanceOf(mcp_error)
    expect((err as Error).message).toBe(
      'MCP server does not advertise the `resources.listChanged` capability, so resources.on_list_changed would never hear from it: call resources.list when you need the current listing',
    )
    await resources.subscribe(README, vi.fn())
  })

  /** `create_resources` over a low-level server, which lists no tools. */
  async function resources_over_bare(server: Server): Promise<McpResources> {
    return create_resources(await connect(server), (err) => err)
  }

  it('sends every request unchecked when the handshake was skipped and nothing is known', async () => {
    const fake = {
      getServerCapabilities: () => undefined,
      listResources: vi.fn(async () => ({ resources: [{ uri: README, name: 'readme' }] })),
      listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
      readResource: vi.fn(async () => ({ contents: [{ uri: README, text: 'hi' }] })),
      subscribeResource: vi.fn(async () => ({})),
      unsubscribeResource: vi.fn(async () => ({})),
      setNotificationHandler: vi.fn(),
    }
    const resources = create_resources(fake as never, (err) => err)

    expect(await resources.list()).toStrictEqual([{ uri: README, name: 'readme' }])
    expect(await resources.templates()).toStrictEqual([])
    expect(await resources.read(README)).toStrictEqual([{ uri: README, text: 'hi' }])
    await resources.subscribe(README, vi.fn())
    await resources.on_list_changed(vi.fn())
    await resources.unsubscribe(README)

    expect(fake.listResources.mock.calls).toEqual([[undefined]])
    expect(fake.listResourceTemplates.mock.calls).toEqual([[undefined]])
    expect(fake.readResource.mock.calls).toEqual([[{ uri: README }]])
    expect(fake.subscribeResource.mock.calls).toEqual([[{ uri: README }]])
    expect(fake.unsubscribeResource.mock.calls).toEqual([[{ uri: README }]])
    expect(fake.setNotificationHandler).toHaveBeenCalledTimes(2)
  })
})

describe('create_resources error translation', () => {
  it('passes each failed request through the translator', async () => {
    const failure = new Error('401 from the wire')
    const fail = async (): Promise<never> => {
      throw failure
    }
    const fake = {
      getServerCapabilities: () => undefined,
      listResources: fail,
      listResourceTemplates: fail,
      readResource: fail,
      subscribeResource: fail,
      // The first subscribe below must leave nothing behind, or this is
      // reached; the second test seeds a subscription to reach it.
      unsubscribeResource: fail,
      setNotificationHandler: vi.fn(),
    }
    const seen: unknown[] = []
    const translated = new Error('translated')
    const resources = create_resources(fake as never, (err) => {
      seen.push(err)
      return translated
    })

    expect(await rejection(resources.list())).toBe(translated)
    expect(await rejection(resources.templates())).toBe(translated)
    expect(await rejection(resources.read(README))).toBe(translated)
    expect(await rejection(resources.subscribe(README, vi.fn()))).toBe(translated)
    expect(seen).toEqual([failure, failure, failure, failure])
  })

  it('translates a failed unsubscribe, having already dropped the callbacks', async () => {
    const failure = new Error('gone')
    const fake = {
      getServerCapabilities: () => undefined,
      subscribeResource: vi.fn(async () => ({})),
      unsubscribeResource: vi.fn(async () => {
        throw failure
      }),
      setNotificationHandler: vi.fn(),
    }
    const translated = new Error('translated')
    const resources = create_resources(fake as never, () => translated)
    await resources.subscribe(README, vi.fn())

    expect(await rejection(resources.unsubscribe(README))).toBe(translated)
    await resources.unsubscribe(README)
    expect(fake.unsubscribeResource).toHaveBeenCalledTimes(1)
  })
})
