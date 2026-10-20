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
import type { AgentApp, AgentContext, ClientCapabilities, SessionUpdate } from '@agentclientprotocol/sdk'
import { create_card_sync, message_of, session_approver } from './approve.js'
import type { PermissionAsker } from './approve.js'
import {
  config_options,
  DEFAULT_MODE,
  is_acp_mode,
  MODE_CONFIG_ID,
  mode_state,
  session_modes,
  unknown_mode_message,
} from './modes.js'
import type { SessionModes } from './modes.js'
import { cancel_turn, prompt_turn } from './prompt_turn.js'
import type { SessionRecord } from './prompt_turn.js'
import { load_acp_sdk } from './sdk_loader.js'
import { resolve_roots } from './tools/containment.js'
import type { AcpMode, AcpSession, ServeAcpConfig } from './types.js'

type AcpSdk = Awaited<ReturnType<typeof load_acp_sdk>>

/** A session as the agent holds it: what a turn needs, and its mode. */
type AgentSession<i, o> = SessionRecord<i, o> & { readonly modes: SessionModes }

const ONE_CONNECTION =
  'acp_agent: this app already serves a connection; build an app for each connection, as serve_acp does'

/**
 * Turn a failure inside a handler into a JSON-RPC error that carries its
 * message. The SDK reports a plain thrown `Error` as a bare "Internal error",
 * which tells the user in the client nothing about what went wrong.
 */
function internal_error(sdk: AcpSdk, err: unknown): Error {
  return sdk.RequestError.internalError(undefined, message_of(err))
}

/**
 * A function that sends one update to the client for one session.
 */
function sender(sdk: AcpSdk, client: AgentContext, sessionId: string): (update: SessionUpdate) => Promise<void> {
  return (update) => client.notify(sdk.methods.client.session.update, { sessionId, update })
}

/**
 * A function that asks the client to approve one tool call. The SDK
 * withdraws the request with `$/cancel_request` once `cancel` fires, which
 * is the turn's abort, so a cancelled turn takes its prompt down with it.
 */
function permission_asker(sdk: AcpSdk, client: AgentContext): PermissionAsker {
  return (request, cancel) =>
    client.request(sdk.methods.client.session.requestPermission, request, { cancellationSignal: cancel })
}

/**
 * The mode a client asked for, or an invalid-params error naming the modes
 * there are. `field` is the param the id arrived in, for the error's data.
 */
function requested_mode(sdk: AcpSdk, id: unknown, field: 'modeId' | 'value'): AcpMode {
  if (is_acp_mode(id)) return id
  throw sdk.RequestError.invalidParams({ [field]: id }, unknown_mode_message(id))
}

/**
 * The additional directories a client sent with a session request, or, from
 * an agent whose config sets `additional_directories: false`, an
 * invalid-params error refusing them. Every session request that carries
 * `additionalDirectories` goes through this check before its roots resolve,
 * so each one refuses them the same way. The protocol reads an empty list as
 * none, so an empty list passes.
 */
function requested_directories(
  sdk: AcpSdk,
  config: { readonly additional_directories?: boolean | undefined },
  method: string,
  directories: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  if (config.additional_directories !== false || directories.length === 0) return directories
  throw sdk.RequestError.invalidParams(
    { additionalDirectories: directories },
    `this agent works in cwd alone and takes no additional directories; send ${method} without additionalDirectories`,
  )
}

/**
 * Build the ACP agent app that answers each prompt turn by running the
 * config's flow, with its handlers registered and not yet connected.
 *
 * An app serves one connection for its life, since its sessions and the
 * client's capabilities aren't scoped to a connection. A second `connect`
 * throws, and so, for a server that routes a second client to the same app
 * and runs `initialize` before any connect hook, does a second `initialize`,
 * before it can overwrite the first client's capabilities.
 */
export async function acp_agent<i, o>(config: ServeAcpConfig<i, o>): Promise<AgentApp> {
  const sdk = await load_acp_sdk()
  const sessions = new Map<string, AgentSession<i, o>>()
  let client_capabilities: ClientCapabilities = {}
  let connected = false
  let initialized = false
  const session_of = (sessionId: string): AgentSession<i, o> => {
    const record = sessions.get(sessionId)
    if (record !== undefined) return record
    throw sdk.RequestError.invalidParams({ sessionId }, `unknown session ${sessionId}; start one with session/new first`)
  }
  return sdk
    .agent()
    .onConnect(() => {
      if (connected) throw new Error(ONE_CONNECTION)
      connected = true
    })
    .onRequest('initialize', (ctx) => {
      if (initialized) throw sdk.RequestError.invalidRequest(undefined, ONE_CONNECTION)
      initialized = true
      client_capabilities = ctx.params.clientCapabilities ?? {}
      return {
        protocolVersion: sdk.PROTOCOL_VERSION,
        agentInfo: { name: config.name, version: config.version ?? '0.0.0' },
        // Embedded context lets a file the user @-mentions arrive with its
        // text, rather than as a bare URI the flow has no way to read. The
        // agent advertises additional directories, which let a client widen
        // the workspace past `cwd`, unless the config sets
        // `additional_directories: false`.
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { embeddedContext: true },
          sessionCapabilities: config.additional_directories === false ? {} : { additionalDirectories: {} },
        },
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
    .onRequest('session/new', async (ctx) => {
      // `mcpServers` is accepted and ignored until a flow can be handed them.
      const { cwd } = ctx.params
      const additional_directories = requested_directories(sdk, config, 'session/new', ctx.params.additionalDirectories)
      // The roots resolve once, here, so every containment check compares
      // against the same real paths for the life of the session.
      const roots = await resolve_roots([cwd, ...additional_directories]).catch((err: unknown) => {
        throw sdk.RequestError.invalidParams({ cwd, additionalDirectories: additional_directories }, message_of(err))
      })
      const id = randomUUID()
      const modes = session_modes(config.default_mode ?? DEFAULT_MODE, sender(sdk, ctx.client, id))
      const cards = create_card_sync()
      const approver = session_approver({ modes, cards, ask: permission_asker(sdk, ctx.client) })
      const session: AcpSession = {
        id,
        cwd,
        additional_directories,
        roots,
        client_capabilities,
        mode: modes.current,
        approve: (request) => approver(session, request),
      }
      try {
        const flow = typeof config.flow === 'function' ? config.flow(session) : config.flow
        sessions.set(id, { session, flow, history: [], cards, last_turn: null, modes })
      } catch (err: unknown) {
        throw internal_error(sdk, err)
      }
      return { sessionId: id, modes: mode_state(modes.current()), configOptions: config_options(modes.current()) }
    })
    .onRequest('session/prompt', async (ctx) => {
      const { sessionId, prompt } = ctx.params
      const record = session_of(sessionId)
      try {
        return await prompt_turn(config, record, prompt, ctx.signal, sender(sdk, ctx.client, sessionId))
      } catch (err: unknown) {
        throw internal_error(sdk, err)
      }
    })
    .onRequest('session/set_mode', async (ctx) => {
      const { sessionId, modeId } = ctx.params
      const { modes } = session_of(sessionId)
      await modes.switch_to(requested_mode(sdk, modeId, 'modeId'))
      return {}
    })
    .onRequest('session/set_config_option', async (ctx) => {
      const { sessionId, configId, value } = ctx.params
      const { modes } = session_of(sessionId)
      if (configId !== MODE_CONFIG_ID) {
        throw sdk.RequestError.invalidParams(
          { configId },
          `unknown config option ${configId}; the only one is ${MODE_CONFIG_ID}`,
        )
      }
      await modes.switch_to(requested_mode(sdk, value, 'value'))
      return { configOptions: config_options(modes.current()) }
    })
    .onNotification('session/cancel', (ctx) => {
      const record = sessions.get(ctx.params.sessionId)
      if (record !== undefined) cancel_turn(record)
    })
}
