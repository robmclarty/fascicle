/**
 * Test helpers: drive an ACP agent app from an in-process client over the
 * real wire format.
 *
 * Messages cross as newline-delimited JSON through a `TransformStream` pair,
 * the SDK's own wire-level test pattern, rather than app to app. Direct
 * composition hands message objects across by reference, which would hide a
 * payload that doesn't survive JSON or a history that isn't copied. The
 * SDK's client also drops a malformed update with a `console.error` instead
 * of throwing into the test, so tests assert that each expected update
 * arrives rather than that nothing failed.
 */

import { tmpdir } from 'node:os'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type {
  ActiveSession,
  AgentApp,
  AgentConnection,
  ClientApp,
  ClientCapabilities,
  ClientConnection,
  ClientContext,
  NewSessionRequest,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk'

export type ConnectedClient = {
  /** Calls the agent's methods. */
  readonly agent: ClientContext
  readonly client_connection: ClientConnection
  readonly agent_connection: AgentConnection
}

export type OpenSessionOptions = {
  /** The client app, for a test that handles client-side requests; default: a bare `client()`. */
  readonly client?: ClientApp
  readonly client_capabilities?: ClientCapabilities
  readonly session?: Partial<NewSessionRequest>
}

export type OpenSession = ConnectedClient & {
  readonly session: ActiveSession
}

export type TurnRecord = {
  readonly updates: ReadonlyArray<SessionUpdate>
  readonly stop_reason: StopReason
}

/**
 * Connect `client_app` to `app` over ndjson through a `TransformStream` pair.
 */
export function connect_client(app: AgentApp, client_app: ClientApp = client()): ConnectedClient {
  const client_to_agent = new TransformStream<Uint8Array, Uint8Array>()
  const agent_to_client = new TransformStream<Uint8Array, Uint8Array>()
  const agent_connection = app.connect(ndJsonStream(agent_to_client.writable, client_to_agent.readable))
  const client_connection = client_app.connect(ndJsonStream(client_to_agent.writable, agent_to_client.readable))
  return { agent: client_connection.agent, client_connection, agent_connection }
}

/**
 * Connect a client, initialize, and start one session in the system's temp
 * directory unless the options say otherwise. `session/new` resolves its
 * roots on disk, so the default has to be a directory that exists.
 */
export async function open_session(app: AgentApp, options: OpenSessionOptions = {}): Promise<OpenSession> {
  const connected = connect_client(app, options.client)
  await connected.agent.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: options.client_capabilities ?? {},
  })
  const session = await connected.agent
    .buildSession({ cwd: tmpdir(), mcpServers: [], ...options.session })
    .start()
  return { ...connected, session }
}

/**
 * Read a session's updates until its turn stops, in the order they arrived.
 */
export async function read_turn(session: ActiveSession): Promise<TurnRecord> {
  const updates: SessionUpdate[] = []
  for (;;) {
    const message = await session.nextUpdate()
    if (message.kind === 'stop') return { updates, stop_reason: message.stopReason }
    updates.push(message.update)
  }
}

/**
 * Read a session's updates until one matches `predicate`, returning every
 * update read so far, so a test can act mid-turn.
 */
export async function read_until(
  session: ActiveSession,
  predicate: (update: SessionUpdate) => boolean,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (;;) {
    const message = await session.nextUpdate()
    if (message.kind === 'stop') throw new Error(`the turn stopped (${message.stopReason}) before the update arrived`)
    updates.push(message.update)
    if (predicate(message.update)) return updates
  }
}
