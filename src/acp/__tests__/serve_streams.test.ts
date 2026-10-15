import { describe, expect, it } from 'vitest'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk'
import { aborted_error, step } from '#core'
import { read_turn } from '../test/connect_client.js'
import { serve_streams } from '../serve_streams.js'
import type { ServeAcpConfig } from '../types.js'

type Served = {
  readonly client_connection: ClientConnection
  /** Closes the client's side of the pipe, the way stdin reaches EOF when a host hangs up. */
  readonly hang_up: () => Promise<void>
  readonly served: Promise<void>
}

/**
 * Serve `config` over a `TransformStream` pair, with a client on the other
 * end that writes ndjson the way a host writes to the agent's stdin.
 */
function serve(config: ServeAcpConfig<string, string>, shutdown?: AbortSignal): Served {
  const client_to_agent = new TransformStream<Uint8Array, Uint8Array>()
  const agent_to_client = new TransformStream<Uint8Array, Uint8Array>()
  const served = serve_streams(config, {
    input: client_to_agent.readable,
    output: agent_to_client.writable,
    shutdown,
  })
  const client_connection = client().connect(ndJsonStream(client_to_agent.writable, agent_to_client.readable))
  return { client_connection, hang_up: () => client_to_agent.writable.close(), served }
}

async function open(connection: ClientConnection): Promise<ActiveSession> {
  await connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return connection.agent.buildSession({ cwd: '/workspace', mcpServers: [] }).start()
}

/**
 * Send a prompt without waiting on its answer. The agent stops reading when
 * its connection closes but leaves its output open, so an in-process client
 * never hears the answer; a real host sees the pipe close as the process
 * exits.
 */
function send_prompt(session: ActiveSession, text: string): void {
  void session.prompt(text).catch(() => undefined)
}

/**
 * A flow that waits for its turn's abort, logging when it starts and the
 * abort's reason when it ends, so a test can order the aborts against the
 * engine's disposal.
 */
function stalled_flow(log: string[]) {
  const started: Array<PromiseWithResolvers<void>> = [Promise.withResolvers(), Promise.withResolvers()]
  const flow = step('stall', async (text: string, ctx) => {
    started[log.filter((line) => line.startsWith('started')).length]?.resolve()
    log.push(`started ${text}`)
    await new Promise<void>((resolve) => {
      ctx.abort.addEventListener('abort', () => {
        const reason: unknown = ctx.abort.reason
        log.push(`aborted ${text}: ${reason instanceof Error ? reason.message : String(reason)}`)
        resolve()
      })
    })
    throw ctx.abort.reason
  })
  return { flow, started: Promise.all(started.map((d) => d.promise)) }
}

/** An engine whose dispose logs, and settles only when the test says so. */
function held_engine(log: string[]) {
  const release = Promise.withResolvers<void>()
  const engine = {
    dispose: async () => {
      log.push('dispose')
      await release.promise
      log.push('disposed')
    },
  }
  return { engine, release: () => release.resolve() }
}

/** Answer whether `promise` has settled, after letting pending callbacks run. */
async function is_settled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  return settled
}

describe('serve_streams', () => {
  it('serves the agent over the streams it is handed until the client hangs up', async () => {
    const { client_connection, hang_up, served } = serve({
      name: 'test-agent',
      flow: step('echo', (text: string) => `echo: ${text}`),
    })
    const session = await open(client_connection)
    await session.prompt('hi')
    expect(await read_turn(session)).toEqual({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo: hi' } }],
      stop_reason: 'end_turn',
    })
    await hang_up()
    await expect(served).resolves.toBeUndefined()
  })

  it('aborts every active run when the client disconnects, then awaits the engine disposal', async () => {
    const log: string[] = []
    const { flow, started } = stalled_flow(log)
    const { engine, release } = held_engine(log)
    const { client_connection, hang_up, served } = serve({ name: 'test-agent', flow, engine })
    const [first, second] = await Promise.all([open(client_connection), open(client_connection)])
    send_prompt(first, 'a')
    send_prompt(second, 'b')
    await started

    await hang_up()
    await expect.poll(() => log.includes('dispose')).toBe(true)
    expect(log.slice(2)).toEqual([
      'aborted a: ACP connection closed',
      'aborted b: ACP connection closed',
      'dispose',
    ])
    expect(await is_settled(served)).toBe(false)

    release()
    await expect(served).resolves.toBeUndefined()
    expect(log.at(-1)).toBe('disposed')
  })

  it('closes the connection when shutdown fires, aborting every active run with its reason', async () => {
    const log: string[] = []
    const { flow, started } = stalled_flow(log)
    const { engine, release } = held_engine(log)
    const shutdown = new AbortController()
    const { client_connection, served } = serve({ name: 'test-agent', flow, engine }, shutdown.signal)
    const [first, second] = await Promise.all([open(client_connection), open(client_connection)])
    send_prompt(first, 'a')
    send_prompt(second, 'b')
    await started

    shutdown.abort(new aborted_error('received SIGTERM'))
    release()
    await expect(served).resolves.toBeUndefined()
    expect(log.slice(2)).toEqual([
      'aborted a: received SIGTERM',
      'aborted b: received SIGTERM',
      'dispose',
      'disposed',
    ])
  })

  it('closes at once when shutdown fired before the connection opened', async () => {
    const log: string[] = []
    const { engine, release } = held_engine(log)
    release()
    const { served } = serve(
      { name: 'test-agent', flow: step('echo', (text: string) => text), engine },
      AbortSignal.abort(new aborted_error('received SIGINT')),
    )
    await expect(served).resolves.toBeUndefined()
    expect(log).toEqual(['dispose', 'disposed'])
  })

  it('serves without an engine to dispose', async () => {
    const shutdown = new AbortController()
    const { client_connection, served } = serve(
      { name: 'test-agent', flow: step('echo', (text: string) => text) },
      shutdown.signal,
    )
    await open(client_connection)
    shutdown.abort(new aborted_error('received SIGTERM'))
    await expect(served).resolves.toBeUndefined()
  })
})
