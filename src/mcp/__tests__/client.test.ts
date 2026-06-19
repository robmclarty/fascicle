import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolExecContext } from '#engine'
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
