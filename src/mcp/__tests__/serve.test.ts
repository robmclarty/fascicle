import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Step, TrajectoryLogger } from '#core'

// run() is mocked so the registered handler can be inspected in isolation:
// these tests assert exactly which options serve_flow threads into run() and how
// it shapes results, which the end-to-end round_trip suite cannot observe.
const { run_mock } = vi.hoisted(() => ({ run_mock: vi.fn() }))
vi.mock('#core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#core')>()
  return { ...actual, run: run_mock }
})

const { serve_flow } = await import('../serve.js')

type Registration = { config: Record<string, unknown>; handler: (input: unknown, extra: { signal: AbortSignal }) => Promise<unknown> }

function fake_server(): { server: McpServer; registrations: Map<string, Registration> } {
  const registrations = new Map<string, Registration>()
  const server = {
    registerTool: vi.fn((name: string, config: Record<string, unknown>, handler: Registration['handler']) => {
      registrations.set(name, { config, handler })
    }),
  }
  return { server: server as unknown as McpServer, registrations }
}

// serve_flow only forwards `flow` to run(), which is mocked, so the step body
// never executes here.
const flow = { name: 'noop' } as unknown as Step<unknown, unknown>
const input_schema = z.object({ x: z.number() })

beforeEach(() => {
  run_mock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('serve_flow', () => {
  it('registers the tool with its description and input schema', () => {
    const { server, registrations } = fake_server()
    serve_flow({ server, flow, name: 'f', description: 'does a thing', input_schema })
    expect(registrations.get('f')?.config).toEqual({ description: 'does a thing', inputSchema: input_schema })
  })

  it('threads abort, disabled signal handlers, and the trajectory into run()', async () => {
    run_mock.mockResolvedValue({ ok: 1 })
    const trajectory = { record: () => undefined } as unknown as TrajectoryLogger
    const { server, registrations } = fake_server()
    serve_flow({ server, flow, name: 'f', description: 'd', input_schema, trajectory })

    const signal = new AbortController().signal
    const result = await registrations.get('f')?.handler({ x: 1 }, { signal })

    expect(run_mock).toHaveBeenCalledWith(flow, { x: 1 }, {
      install_signal_handlers: false,
      abort: signal,
      trajectory,
    })
    expect(result).toEqual({ content: [{ type: 'text', text: '{"ok":1}' }], structuredContent: { ok: 1 } })
  })

  it('omits the trajectory key from run options when none is supplied', async () => {
    run_mock.mockResolvedValue('done')
    const { server, registrations } = fake_server()
    serve_flow({ server, flow, name: 'f', description: 'd', input_schema })

    const signal = new AbortController().signal
    await registrations.get('f')?.handler({ x: 1 }, { signal })

    const options = run_mock.mock.calls[0]?.[2] as Record<string, unknown>
    expect(options).toEqual({ install_signal_handlers: false, abort: signal })
    expect('trajectory' in options).toBe(false)
  })

  it('maps a thrown Error to an isError result carrying the message', async () => {
    run_mock.mockRejectedValue(new Error('kaboom'))
    const { server, registrations } = fake_server()
    serve_flow({ server, flow, name: 'f', description: 'd', input_schema })

    const result = await registrations.get('f')?.handler({ x: 1 }, { signal: new AbortController().signal })
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'kaboom' }] })
  })

  it('stringifies a non-Error rejection for the isError result', async () => {
    run_mock.mockRejectedValue('plain failure')
    const { server, registrations } = fake_server()
    serve_flow({ server, flow, name: 'f', description: 'd', input_schema })

    const result = await registrations.get('f')?.handler({ x: 1 }, { signal: new AbortController().signal })
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'plain failure' }] })
  })
})
