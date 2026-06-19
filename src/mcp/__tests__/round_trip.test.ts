import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { run, step } from '#core'
import type { ToolExecContext } from '#engine'
import { mcp_client } from '../client.js'
import { mcp_error } from '../errors.js'
import { serve_flow } from '../serve.js'

function exec_ctx(): ToolExecContext {
  return { abort: new AbortController().signal, tool_call_id: 'tc-1', step_index: 0 }
}

async function linked_client(server: McpServer): Promise<Client> {
  const [client_transport, server_transport] = InMemoryTransport.createLinkedPair()
  await server.connect(server_transport)
  const client = new Client({ name: 'round-trip-test', version: '0.0.0' })
  await client.connect(client_transport)
  return client
}

describe('mcp round trip (serve_flow -> wire -> mcp_client)', () => {
  const open: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(open.splice(0).map((c) => c.close()))
  })

  it('exposes a flow as a tool and runs it back through the bridge', async () => {
    const shout = step('shout', (input: { text: string }) => ({ shout: input.text.toUpperCase() }))
    const server = new McpServer({ name: 'round-trip', version: '0.0.0' })
    serve_flow({
      server,
      flow: shout,
      name: 'shout',
      description: 'Uppercase the input text.',
      input_schema: z.object({ text: z.string() }),
    })

    const client = await linked_client(server)
    open.push(server, client)
    const handle = await mcp_client({ transport: 'client', client })

    const tool = handle.tools.find((t) => t.name === 'shout')
    expect(tool).toBeDefined()
    expect(tool?.description).toBe('Uppercase the input text.')

    // The input schema survived Zod -> JSON Schema -> Zod and still validates.
    expect(tool?.input_schema.safeParse({ text: 'hi' }).success).toBe(true)
    expect(tool?.input_schema.safeParse({ text: 1 }).success).toBe(false)

    // Structured output round-trips as an object via structuredContent.
    const output = await tool?.execute({ text: 'hi' }, exec_ctx())
    expect(output).toEqual({ shout: 'HI' })
  })

  it('surfaces a thrown flow as an mcp_error on the client side', async () => {
    const boom = step('boom', (_: { n: number }): { ok: boolean } => {
      throw new Error('flow failed')
    })
    const server = new McpServer({ name: 'round-trip-err', version: '0.0.0' })
    serve_flow({
      server,
      flow: boom,
      name: 'boom',
      description: 'Always throws.',
      input_schema: z.object({ n: z.number() }),
    })

    const client = await linked_client(server)
    open.push(server, client)
    const handle = await mcp_client({ transport: 'client', client })
    const tool = handle.tools.find((t) => t.name === 'boom')

    await expect(tool?.execute({ n: 1 }, exec_ctx())).rejects.toBeInstanceOf(mcp_error)
  })

  it('drives a served flow through run() end to end', async () => {
    // run() the served tool directly as a flow: prove the Tool the bridge
    // produced is a first-class step input.
    const add = step('add', (input: { a: number; b: number }) => ({ sum: input.a + input.b }))
    const server = new McpServer({ name: 'round-trip-add', version: '0.0.0' })
    serve_flow({
      server,
      flow: add,
      name: 'add',
      description: 'Add two numbers.',
      input_schema: z.object({ a: z.number(), b: z.number() }),
    })

    const client = await linked_client(server)
    open.push(server, client)
    const handle = await mcp_client({ transport: 'client', client })
    const tool = handle.tools.find((t) => t.name === 'add')

    const result = await run(
      step('call_add', (input: { a: number; b: number }) =>
        tool ? tool.execute(input, exec_ctx()) : null,
      ),
      { a: 2, b: 3 },
      { install_signal_handlers: false },
    )
    expect(result).toEqual({ sum: 5 })
  })
})
