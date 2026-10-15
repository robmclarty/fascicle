/**
 * acp_agent: the ACP agent app that answers each prompt turn by running a
 * flow.
 *
 * It registers the protocol v1 handlers and holds the sessions, and connects
 * to anything the SDK can: `serve_acp`'s stdio streams, or an in-process
 * `client()` in a test. It doesn't own the process, so it leaves the console
 * and the engine alone; `serve_acp` handles both.
 */

import { randomUUID } from 'node:crypto'
import type { AgentApp, ClientCapabilities, SessionUpdate } from '@agentclientprotocol/sdk'
import { cancel_turn, prompt_turn } from './prompt_turn.js'
import type { SessionRecord } from './prompt_turn.js'
import { load_acp_sdk } from './sdk_loader.js'
import type { AcpSession, ServeAcpConfig } from './types.js'

type AcpSdk = Awaited<ReturnType<typeof load_acp_sdk>>

/**
 * Turn a failure inside a handler into a JSON-RPC error that carries its
 * message. The SDK reports a plain thrown `Error` as a bare "Internal error",
 * which tells the user in the client nothing about what went wrong.
 */
function internal_error(sdk: AcpSdk, err: unknown): Error {
  return sdk.RequestError.internalError(undefined, err instanceof Error ? err.message : String(err))
}

/**
 * Build the ACP agent app that answers each prompt turn by running the
 * config's flow, with its handlers registered and not yet connected.
 */
export async function acp_agent<i, o>(config: ServeAcpConfig<i, o>): Promise<AgentApp> {
  const sdk = await load_acp_sdk()
  const sessions = new Map<string, SessionRecord<i, o>>()
  let client_capabilities: ClientCapabilities = {}
  return sdk
    .agent()
    .onRequest('initialize', (ctx) => {
      client_capabilities = ctx.params.clientCapabilities ?? {}
      return {
        protocolVersion: sdk.PROTOCOL_VERSION,
        agentInfo: { name: config.name, version: config.version ?? '0.0.0' },
        // Embedded context lets a file the user @-mentions arrive with its
        // text, rather than as a bare URI the flow has no way to read.
        agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true } },
        // Providers authenticate with what the launched process can see;
        // ACP v1 gives the client no way to hand the agent credentials.
        authMethods: [],
      }
    })
    .onRequest(
      'authenticate',
      // Stryker disable next-line ArrowFunction: the SDK answers an authenticate handler's undefined with {}, so both read the same on the wire.
      () => ({}),
    )
    .onRequest('session/new', (ctx) => {
      // `mcpServers` is accepted and ignored until a flow can be handed them.
      const session: AcpSession = { id: randomUUID(), cwd: ctx.params.cwd, client_capabilities }
      try {
        const flow = typeof config.flow === 'function' ? config.flow(session) : config.flow
        sessions.set(session.id, { session, flow, history: [], last_turn: null })
      } catch (err: unknown) {
        throw internal_error(sdk, err)
      }
      return { sessionId: session.id }
    })
    .onRequest('session/prompt', async (ctx) => {
      const { sessionId, prompt } = ctx.params
      const record = sessions.get(sessionId)
      if (record === undefined) {
        throw sdk.RequestError.invalidParams(
          { sessionId },
          `unknown session ${sessionId}; start one with session/new first`,
        )
      }
      const send = (update: SessionUpdate): Promise<void> =>
        ctx.client.notify(sdk.methods.client.session.update, { sessionId, update })
      try {
        return await prompt_turn(config, record, prompt, ctx.signal, send)
      } catch (err: unknown) {
        throw internal_error(sdk, err)
      }
    })
    .onNotification('session/cancel', (ctx) => {
      const record = sessions.get(ctx.params.sessionId)
      if (record !== undefined) cancel_turn(record)
    })
}
