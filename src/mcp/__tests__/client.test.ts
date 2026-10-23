import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { create_engine } from '#engine'
import type { ToolExecContext, TurnRequest, TurnResult } from '#engine'
import { mcp_error } from '../errors.js'
import { mcp_client } from '../client.js'

const open: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()))
})

async function connect(server: McpServer): Promise<Client> {
  const [client_transport, server_transport] = InMemoryTransport.createLinkedPair()
  await server.connect(server_transport)
  const client = new Client({ name: 'client-test', version: '0.0.0' })
  await client.connect(client_transport)
  open.push(server, client)
  return client
}

function server_with_two_tools(): McpServer {
  const server = new McpServer({ name: 'two-tools', version: '0.0.0' })
  server.registerTool(
    'alpha',
    { description: 'first', inputSchema: { x: z.number() } },
    async ({ x }) => ({ content: [{ type: 'text', text: String(x) }] }),
  )
  // Registered with no description to exercise the default_description fallback.
  server.registerTool(
    'beta',
    { inputSchema: { y: z.number() } },
    async ({ y }) => ({ content: [{ type: 'text', text: String(y) }] }),
  )
  return server
}

describe('mcp_client', () => {
  it('surfaces all advertised tools by default', async () => {
    const client = await connect(server_with_two_tools())
    const handle = await mcp_client({ transport: 'client', client })
    expect(handle.tools.map((t) => t.name).toSorted()).toEqual(['alpha', 'beta'])
  })

  it('honors an include allowlist', async () => {
    const client = await connect(server_with_two_tools())
    const handle = await mcp_client({ transport: 'client', client }, { include: ['alpha'] })
    expect(handle.tools.map((t) => t.name)).toEqual(['alpha'])
  })

  it('falls back to default_description when a tool advertises none', async () => {
    const client = await connect(server_with_two_tools())
    const handle = await mcp_client(
      { transport: 'client', client },
      { default_description: (name) => `tool:${name}` },
    )
    const beta = handle.tools.find((t) => t.name === 'beta')
    expect(beta?.description).toBe('tool:beta')
    // A described tool keeps its own description.
    expect(handle.tools.find((t) => t.name === 'alpha')?.description).toBe('first')
  })

  it('falls back to "MCP tool <name>" when nothing else describes a tool', async () => {
    const client = await connect(server_with_two_tools())
    const handle = await mcp_client({ transport: 'client', client })
    expect(handle.tools.find((t) => t.name === 'beta')?.description).toBe('MCP tool beta')
  })

  it('rejects a tool call when the run is already aborted', async () => {
    const client = await connect(server_with_two_tools())
    const handle = await mcp_client({ transport: 'client', client })
    const alpha = handle.tools.find((t) => t.name === 'alpha')

    const controller = new AbortController()
    const cause = new Error('cancelled')
    controller.abort(cause)
    const ctx: ToolExecContext = {
      abort: controller.signal,
      tool_call_id: 'tc-1',
      step_index: 0,
    }
    await expect(alpha?.execute({ x: 1 }, ctx)).rejects.toBe(cause)
  })

  it('close is a no-op for an injected client (caller owns its lifecycle)', async () => {
    const client = await connect(server_with_two_tools())
    const handle = await mcp_client({ transport: 'client', client })
    await handle.close()
    // The injected client is still usable: listing tools again succeeds.
    const relisted = await client.listTools()
    expect(relisted.tools.length).toBe(2)
  })
})

describe('mcp_client name_prefix', () => {
  /** A server whose tools record each call by the name the server received. */
  function recording_server(received: string[]): McpServer {
    const server = new McpServer({ name: 'prefixed', version: '0.0.0' })
    server.registerTool(
      'alpha',
      { description: 'first', inputSchema: { x: z.number() } },
      async ({ x }) => {
        received.push(`alpha:${String(x)}`)
        return { content: [{ type: 'text', text: String(x * 2) }] }
      },
    )
    server.registerTool('beta', { inputSchema: { y: z.number() } }, async () => {
      received.push('beta')
      return { content: [{ type: 'text', text: 'beta broke' }], isError: true }
    })
    return server
  }

  /** An engine whose model calls `gh_alpha` once, then answers. */
  function scripted_engine(requests: TurnRequest[]): ReturnType<typeof create_engine> {
    const usage = { input_tokens: 1, output_tokens: 1 }
    const turns: TurnResult[] = [
      {
        text: '',
        tool_calls: [{ id: 'c1', name: 'gh_alpha', input: { x: 21 } }],
        finish_reason: 'tool_calls',
        usage,
      },
      { text: 'done', tool_calls: [], finish_reason: 'stop', usage },
    ]
    return create_engine({
      providers: { model: {} },
      custom_providers: {
        model: () => ({
          kind: 'native',
          name: 'model',
          supports: () => true,
          invoke_turn: async (req) => {
            requests.push(req)
            const turn = turns[requests.length - 1]
            if (turn === undefined) throw new Error(`no turn ${String(requests.length)}`)
            return turn
          },
        }),
      },
    })
  }

  it('shows the model each tool under the prefix and calls the server by its own name', async () => {
    const received: string[] = []
    const client = await connect(recording_server(received))
    const handle = await mcp_client({ transport: 'client', client }, { name_prefix: 'gh_' })
    const requests: TurnRequest[] = []

    const result = await scripted_engine(requests).generate({
      model: 'm',
      prompt: 'go',
      tools: [...handle.tools],
    })

    expect(requests[0]?.tools.map((t) => t.name).toSorted()).toEqual(['gh_alpha', 'gh_beta'])
    expect(received).toEqual(['alpha:21'])
    expect(requests[1]?.messages.at(-1)).toStrictEqual({
      role: 'tool',
      tool_call_id: 'c1',
      name: 'gh_alpha',
      content: '42',
    })
    expect(result.content).toBe('done')
  })

  it('reads include and default_description by the server\'s name, which the fallback keeps too', async () => {
    const client = await connect(recording_server([]))
    const included = await mcp_client(
      { transport: 'client', client },
      { name_prefix: 'gh_', include: ['beta'], default_description: (name) => `tool:${name}` },
    )
    expect(included.tools.map((t) => [t.name, t.description])).toEqual([['gh_beta', 'tool:beta']])

    const plain = await mcp_client({ transport: 'client', client }, { name_prefix: 'gh_' })
    expect(plain.tools.find((t) => t.name === 'gh_beta')?.description).toBe('MCP tool beta')
  })

  it("names the server's tool in its errors", async () => {
    const client = await connect(recording_server([]))
    const handle = await mcp_client({ transport: 'client', client }, { name_prefix: 'gh_' })
    const beta = handle.tools.find((t) => t.name === 'gh_beta')
    const ctx: ToolExecContext = {
      abort: new AbortController().signal,
      tool_call_id: 'tc-1',
      step_index: 0,
    }
    const failed = beta?.execute({ y: 1 }, ctx)
    await expect(failed).rejects.toBeInstanceOf(mcp_error)
    await expect(failed).rejects.toMatchObject({ tool_name: 'beta', message: 'beta broke' })

    const controller = new AbortController()
    controller.abort('stop')
    await expect(
      beta?.execute({ y: 1 }, { ...ctx, abort: controller.signal }),
    ).rejects.toMatchObject({ tool_name: 'beta', message: 'MCP tool beta aborted before invocation' })
  })
})
