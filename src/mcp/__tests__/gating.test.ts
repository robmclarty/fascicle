import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import { create_engine } from '#engine'
import type { GenerateResult, ToolApprovalRequest, TurnResult } from '#engine'
import { mcp_client } from '../client.js'
import type { McpAdvertisedTool, McpClientOptions } from '../client.js'

const open: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()))
})

/**
 * A server with `alpha`, which advertises annotations, and `beta`, which
 * advertises none. Each call lands in `received` under the server's own name.
 */
async function connect(received: string[]): Promise<Client> {
  const server = new McpServer({ name: 'gated', version: '0.0.0' })
  server.registerTool(
    'alpha',
    {
      description: 'first',
      inputSchema: { x: z.number() },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ x }) => {
      received.push(`alpha:${String(x)}`)
      return { content: [{ type: 'text', text: String(x) }] }
    },
  )
  server.registerTool('beta', { description: 'second', inputSchema: { y: z.number() } }, async ({ y }) => {
    received.push(`beta:${String(y)}`)
    return { content: [{ type: 'text', text: String(y) }] }
  })
  const [client_transport, server_transport] = InMemoryTransport.createLinkedPair()
  await server.connect(server_transport)
  const client = new Client({ name: 'gating-test', version: '0.0.0' })
  await client.connect(client_transport)
  open.push(server, client)
  return client
}

type Call = { name: string; input: Record<string, unknown> }

type Driven = {
  // What `generate` resolved with, or what it threw.
  result: GenerateResult | undefined
  error: unknown
  received: string[]
  asked: ToolApprovalRequest[]
  requested: TrajectoryEvent[]
  denied: TrajectoryEvent[]
}

/**
 * Surfaces the server's tools under `options`, then runs the real engine loop
 * over a model that makes `calls` in one turn and answers in the next.
 * `approve` is the run's `on_tool_approval`, left off when undefined. A run
 * that throws still reports what the server received and what was recorded.
 */
async function drive(
  options: McpClientOptions,
  calls: Call[],
  approve?: (request: ToolApprovalRequest) => boolean,
): Promise<Driven> {
  const received: string[] = []
  const handle = await mcp_client({ transport: 'client', client: await connect(received) }, options)
  const usage = { input_tokens: 1, output_tokens: 1 }
  const turns: TurnResult[] = [
    {
      text: '',
      tool_calls: calls.map((c, i) => ({ id: `c${String(i)}`, name: c.name, input: c.input })),
      finish_reason: 'tool_calls',
      usage,
    },
    { text: 'done', tool_calls: [], finish_reason: 'stop', usage },
  ]
  let turn = 0
  const engine = create_engine({
    providers: { model: {} },
    custom_providers: {
      model: () => ({
        kind: 'native',
        name: 'model',
        supports: () => true,
        invoke_turn: async () => {
          const next = turns[turn++]
          if (next === undefined) throw new Error('no turn left')
          return next
        },
      }),
    },
  })
  const events: TrajectoryEvent[] = []
  const trajectory: TrajectoryLogger = {
    record: (event) => {
      events.push(event)
    },
    start_span: () => 'span',
    end_span: () => {},
  }
  const asked: ToolApprovalRequest[] = []
  let result: GenerateResult | undefined
  let error: unknown
  try {
    result = await engine.generate({
      model: 'm',
      prompt: 'go',
      tools: [...handle.tools],
      trajectory,
      ...(approve !== undefined
        ? {
            on_tool_approval: (request: ToolApprovalRequest) => {
              asked.push(request)
              return approve(request)
            },
          }
        : {}),
    })
  } catch (err: unknown) {
    error = err
  }
  return {
    result,
    error,
    received,
    asked,
    requested: events.filter((e) => e.kind === 'tool_approval_requested'),
    denied: events.filter((e) => e.kind === 'tool_approval_denied'),
  }
}

const BOTH: Call[] = [
  { name: 'alpha', input: { x: 21 } },
  { name: 'beta', input: { y: 2 } },
]

describe('mcp_client needs_approval', () => {
  it('leaves the needs_approval key off every tool when the option is unset', async () => {
    const handle = await mcp_client({ transport: 'client', client: await connect([]) })
    expect(handle.tools).toHaveLength(2)
    for (const tool of handle.tools) expect('needs_approval' in tool).toBe(false)

    const driven = await drive({}, BOTH)
    expect(driven.requested).toEqual([])
    expect(driven.received).toEqual(['alpha:21', 'beta:2'])
  })

  it('gates every tool for `true`, and the engine asks before each call', async () => {
    const handle = await mcp_client({ transport: 'client', client: await connect([]) }, { needs_approval: true })
    expect(handle.tools.map((t) => t.needs_approval)).toEqual([true, true])

    const driven = await drive({ needs_approval: true }, BOTH, () => true)
    expect(driven.requested.map((e) => e['tool_name'])).toEqual(['alpha', 'beta'])
    expect(driven.asked.map((r) => [r.tool_name, r.input])).toEqual([
      ['alpha', { x: 21 }],
      ['beta', { y: 2 }],
    ])
    expect(driven.received).toEqual(['alpha:21', 'beta:2'])
  })

  it('refuses a gated call before it reaches the server when the run has no approval handler', async () => {
    const driven = await drive({ needs_approval: true }, [{ name: 'alpha', input: { x: 21 } }])
    expect(driven.requested.map((e) => e['tool_name'])).toEqual(['alpha'])
    expect(driven.denied.map((e) => e['tool_name'])).toEqual(['alpha'])
    expect(driven.received).toEqual([])
    expect(driven.result).toBeUndefined()
    expect(driven.error).toMatchObject({
      message:
        "tool approval required for 'alpha': pass an on_tool_approval handler to generate(), or clear needs_approval on the tool",
    })
  })

  it('keeps a denied call from the server and lets an approved one through', async () => {
    const driven = await drive({ needs_approval: true }, BOTH, (request) => request.tool_name === 'beta')
    expect(driven.denied.map((e) => e['tool_name'])).toEqual(['alpha'])
    expect(driven.received).toEqual(['beta:2'])
    expect(driven.result?.content).toBe('done')
  })

  it('stamps `false` as written, which gates nothing', async () => {
    const handle = await mcp_client({ transport: 'client', client: await connect([]) }, { needs_approval: false })
    expect(handle.tools.map((t) => t.needs_approval)).toEqual([false, false])

    const driven = await drive({ needs_approval: false }, BOTH)
    expect(driven.requested).toEqual([])
    expect(driven.received).toEqual(['alpha:21', 'beta:2'])
  })

  it('asks a policy once per tool, by the server\'s name, with the annotations the server advertised', async () => {
    const seen: McpAdvertisedTool[] = []
    const handle = await mcp_client(
      { transport: 'client', client: await connect([]) },
      {
        name_prefix: 'gh_',
        needs_approval: (tool) => {
          seen.push(tool)
          return tool.name === 'alpha'
        },
      },
    )
    // toStrictEqual: `beta` advertised no annotations, so its key is absent.
    expect(seen).toStrictEqual([
      { name: 'alpha', annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: 'beta' },
    ])
    expect('annotations' in (seen[1] ?? {})).toBe(false)
    expect(handle.tools.map((t) => [t.name, t.needs_approval])).toEqual([
      ['gh_alpha', true],
      ['gh_beta', false],
    ])
  })

  it('gates only the tools a policy answers true for', async () => {
    const driven = await drive(
      { name_prefix: 'gh_', needs_approval: (tool) => tool.name === 'alpha' },
      [
        { name: 'gh_alpha', input: { x: 21 } },
        { name: 'gh_beta', input: { y: 2 } },
      ],
      () => true,
    )
    // The engine names the surfaced tool, prefix included, in what it asks.
    expect(driven.requested.map((e) => e['tool_name'])).toEqual(['gh_alpha'])
    expect(driven.received).toEqual(['alpha:21', 'beta:2'])
  })

  it('lets a policy trust a hint the server advertised, in the caller\'s own code', async () => {
    const driven = await drive(
      { needs_approval: (tool) => tool.annotations?.['readOnlyHint'] !== true },
      BOTH,
      () => true,
    )
    expect(driven.requested.map((e) => e['tool_name'])).toEqual(['beta'])
  })

  it('hands a predicate the policy returned to the tool, which the engine runs on each input', async () => {
    const over_ten = (input: unknown): boolean => (input as { x: number }).x > 10
    const handle = await mcp_client(
      { transport: 'client', client: await connect([]) },
      { needs_approval: (tool) => (tool.name === 'alpha' ? over_ten : false) },
    )
    expect(handle.tools.map((t) => t.needs_approval)).toEqual([over_ten, false])

    const driven = await drive(
      { needs_approval: (tool) => (tool.name === 'alpha' ? over_ten : false) },
      [
        { name: 'alpha', input: { x: 21 } },
        { name: 'alpha', input: { x: 3 } },
      ],
      () => true,
    )
    expect(driven.asked.map((r) => r.input)).toEqual([{ x: 21 }])
    expect(driven.requested).toHaveLength(1)
    expect(driven.received).toEqual(['alpha:21', 'alpha:3'])
  })
})
