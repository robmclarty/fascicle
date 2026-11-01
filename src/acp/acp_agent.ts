/**
 * acp_agent: the ACP agent app that answers each prompt turn by running a
 * flow.
 *
 * It registers the protocol v1 handlers and holds the sessions, and connects
 * to anything the SDK can: `serve_acp`'s stdio streams, or an in-process
 * `client()` in a test. It doesn't own the process, so it leaves the console
 * and the engine alone; `serve_acp` handles both.
 *
 * Given a session store, it saves each session after every turn and every
 * mode or model switch, and answers `session/list`, `session/load`, and
 * `session/resume` from it. A loaded session gets a fresh flow from the
 * config, and the history it carries is what its next turn starts from.
 *
 * A session holds what the client gave it until the client closes it with
 * `session/close` or drops the connection: its MCP servers, for an agent
 * that connects to them, are closed then, and a closed session leaves
 * memory, though not the store.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentApp,
  AgentContext,
  ClientCapabilities,
  ListSessionsResponse,
  McpServer,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import { create_card_sync, message_of, session_approver } from './approve.js'
import type { PermissionAsker } from './approve.js'
import { connect_mcp_servers, gated_mcp_tools, MCP_CAPABILITIES, NO_MCP } from './mcp_servers.js'
import type { McpConnections } from './mcp_servers.js'
import {
  context_window_of,
  MODEL_CONFIG_ID,
  model_offer,
  model_options,
  offers_model,
  start_model,
  unknown_model_message,
} from './models.js'
import type { ModelOffer } from './models.js'
import { config_options, MODE_CONFIG_ID, mode_offer, mode_state, session_modes, unknown_mode_message } from './modes.js'
import type { ModeOffer, SessionModes } from './modes.js'
import { cancel_turn, prompt_turn } from './prompt_turn.js'
import type { SessionRecord } from './prompt_turn.js'
import { load_acp_sdk } from './sdk_loader.js'
import { resolve_roots } from './tools/containment.js'
import type { AcpHistoryEntry, AcpMode, AcpSession, AcpSessionSummary, AcpStoredSession, ServeAcpConfig } from './types.js'
import { create_session_usage, usage_update } from './usage.js'
import type { SessionUsage } from './usage.js'

type AcpSdk = Awaited<ReturnType<typeof load_acp_sdk>>

/**
 * A session as the agent holds it: what a turn needs, its mode, its model,
 * its MCP servers, and the latest save, which the next save waits on so two
 * never write at once.
 */
type AgentSession<i, o> = SessionRecord<i, o> & {
  readonly modes: SessionModes
  readonly model: { id: string | undefined }
  readonly mcp: McpConnections
  saving: Promise<void>
}

/**
 * What a session starts from: its workspace, the MCP servers the client
 * sent for it, and for a stored one, where it left off.
 */
type SessionStart = {
  readonly id: string
  readonly cwd: string
  readonly additional_directories: ReadonlyArray<string>
  readonly mcp_servers: ReadonlyArray<McpServer>
  readonly stored?: AcpStoredSession | undefined
}

/** Every config option id a session can have, as a refusal lists them. */
const CONFIG_IDS = `${MODE_CONFIG_ID} and ${MODEL_CONFIG_ID}`

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
 * The model a client asked for, or an invalid-params error naming the
 * models the agent offers.
 */
function requested_model(sdk: AcpSdk, offer: ModelOffer, id: unknown): string {
  if (offers_model(offer, id)) return id
  throw sdk.RequestError.invalidParams({ value: id }, unknown_model_message(id, offer))
}

/**
 * The mode a client asked for, or an invalid-params error naming the modes
 * the agent offers, for a mode it doesn't know and one it leaves out alike.
 * `field` is the param the id arrived in, for the error's data.
 */
function requested_mode(
  sdk: AcpSdk,
  offer: ModeOffer,
  modes: SessionModes,
  id: unknown,
  field: 'modeId' | 'value',
): AcpMode {
  if (modes.offers(id)) return id
  throw sdk.RequestError.invalidParams({ [field]: id }, unknown_mode_message(id, offer))
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
 * A session's state as the store keeps it, copied, so a turn that runs while
 * the save is writing can't change what it writes.
 */
function stored_session<i, o>(record: AgentSession<i, o>): AcpStoredSession {
  return {
    id: record.session.id,
    cwd: record.session.cwd,
    additional_directories: [...record.session.additional_directories],
    mode: record.modes.current(),
    model: record.model.id,
    title: record.title,
    updated_at: new Date().toISOString(),
    history: structuredClone(record.history),
    usage: { ...record.usage },
  }
}

/**
 * Save a session after the save before it. A session with no history yet
 * isn't saved, so a thread the user never wrote in doesn't fill the list. A
 * failed save is reported on stderr rather than failing the turn the user
 * already watched finish, and it leaves the session as it was in the store.
 */
function save_session<i, o>(config: ServeAcpConfig<i, o>, record: AgentSession<i, o>): Promise<void> {
  const store = config.session_store
  if (store === undefined || record.history.length === 0) return Promise.resolve()
  const snapshot = stored_session(record)
  record.saving = record.saving
    .then(() => store.save(snapshot))
    .catch((err: unknown) => {
      process.stderr.write(`fascicle/acp: couldn't save session ${snapshot.id}: ${message_of(err)}\n`)
    })
  return record.saving
}

/**
 * A history entry as the update that shows it again in a loaded thread.
 */
function replayed(entry: AcpHistoryEntry): SessionUpdate {
  const content = { type: 'text' as const, text: entry.text }
  return entry.role === 'user'
    ? { sessionUpdate: 'user_message_chunk', content }
    : { sessionUpdate: 'agent_message_chunk', content }
}

/**
 * A stored session as `session/list` reports one.
 */
function session_info(summary: AcpSessionSummary): SessionInfo {
  return {
    sessionId: summary.id,
    cwd: summary.cwd,
    updatedAt: summary.updated_at,
    ...(summary.additional_directories.length > 0 ? { additionalDirectories: [...summary.additional_directories] } : {}),
    ...(summary.title !== null && summary.title !== '' ? { title: summary.title } : {}),
  }
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
  // A bad config fails here, before the SDK loads, so the error names it.
  const offer = mode_offer(config)
  const models = model_offer(config)
  const sdk = await load_acp_sdk()
  const sessions = new Map<string, AgentSession<i, o>>()
  const store = config.session_store
  const identity = { name: config.name, version: config.version ?? '0.0.0' }
  let client_capabilities: ClientCapabilities = {}
  let connected = false
  let initialized = false
  const session_of = (sessionId: string): AgentSession<i, o> => {
    const record = sessions.get(sessionId)
    if (record !== undefined) return record
    throw sdk.RequestError.invalidParams({ sessionId }, `unknown session ${sessionId}; start one with session/new first`)
  }
  // Every option a session has, the mode first, as each answer and each
  // config option update reports them.
  const options_of = (record: AgentSession<i, o>): SessionConfigOption[] => [
    ...config_options(offer, record.modes.current()),
    ...model_options(models, record.model.id),
  ]
  const build_flow = (session: AcpSession) => (typeof config.flow === 'function' ? config.flow(session) : config.flow)
  // The roots resolve once, here, so every containment check compares
  // against the same real paths for the life of the session. The MCP
  // servers connect before the flow is built, since the builder hands their
  // tools to the model, and close again when the builder throws.
  const open_session = async (client: AgentContext, start: SessionStart): Promise<AgentSession<i, o>> => {
    const { id, cwd, additional_directories, stored } = start
    const roots = await resolve_roots([cwd, ...additional_directories]).catch((err: unknown) => {
      throw sdk.RequestError.invalidParams({ cwd, additionalDirectories: additional_directories }, message_of(err))
    })
    const model = { id: start_model(models, stored?.model) }
    const modes = session_modes(offer, sender(sdk, client, id), stored?.mode, () => model_options(models, model.id))
    const cards = create_card_sync()
    const approver = session_approver({ modes, cards, ask: permission_asker(sdk, client) })
    const mcp = config.mcp_servers === true ? await connect_mcp_servers(start.mcp_servers, cwd, identity) : NO_MCP
    const session: AcpSession = {
      id,
      cwd,
      additional_directories,
      roots,
      client_capabilities,
      mode: modes.current,
      model: () => model.id,
      mcp_tools: gated_mcp_tools(mcp.tools, () => session),
      approve: (request) => approver(session, request),
    }
    const usage: SessionUsage = stored === undefined ? create_session_usage() : { ...stored.usage }
    try {
      const record: AgentSession<i, o> = {
        session,
        flow: build_flow(session),
        history: structuredClone([...(stored?.history ?? [])]),
        cards,
        usage,
        last_turn: null,
        title: stored?.title ?? null,
        modes,
        model,
        mcp,
        saving: Promise.resolve(),
      }
      sessions.set(id, record)
      return record
    } catch (err: unknown) {
      await mcp.close()
      throw internal_error(sdk, err)
    }
  }
  // A session this connection already holds is picked up as it is, and a
  // stored one is opened from the store. Either way the client must send the
  // cwd the session started in, which the protocol lets the roots beside it
  // change.
  const reopen = async (
    client: AgentContext,
    method: 'session/load' | 'session/resume',
    params: {
      sessionId: string
      cwd: string
      additionalDirectories?: ReadonlyArray<string> | undefined
      mcpServers?: ReadonlyArray<McpServer> | undefined
    },
  ): Promise<AgentSession<i, o>> => {
    if (store === undefined) throw sdk.RequestError.methodNotFound(method)
    const { sessionId, cwd } = params
    const additional_directories = requested_directories(sdk, config, method, params.additionalDirectories)
    const live = sessions.get(sessionId)
    const stored = live === undefined ? await store.load(sessionId).catch((err: unknown) => {
      throw internal_error(sdk, err)
    }) : undefined
    const started_in = live?.session.cwd ?? stored?.cwd
    if (started_in === undefined) {
      throw sdk.RequestError.invalidParams({ sessionId }, `unknown session ${sessionId}; list the stored ones with session/list`)
    }
    if (started_in !== cwd) {
      throw sdk.RequestError.invalidParams(
        { sessionId, cwd },
        `session ${sessionId} started in ${started_in}; send that cwd with ${method}`,
      )
    }
    return (
      live ?? open_session(client, { id: sessionId, cwd, additional_directories, mcp_servers: params.mcpServers ?? [], stored })
    )
  }
  // A reopened thread shows its title and its usage again, which the client
  // can't keep for an agent that restarted, and the answer carries its mode
  // and its model.
  const reopened = async (client: AgentContext, record: AgentSession<i, o>) => {
    const send = sender(sdk, client, record.session.id)
    if (record.title !== null && record.title !== '') await send({ sessionUpdate: 'session_info_update', title: record.title })
    const window = context_window_of(config, record.model.id)
    if (window !== undefined && (record.usage.context_tokens > 0 || record.usage.priced)) {
      await send(usage_update(record.usage, window))
    }
    return { modes: mode_state(offer, record.modes.current()), configOptions: options_of(record) }
  }
  // The flow is built again for the new model before the pick takes, so a
  // builder that throws leaves the session on the model it had. A turn in
  // flight keeps the flow it started with.
  const switch_model = (record: AgentSession<i, o>, next: string): void => {
    const previous = record.model.id
    record.model.id = next
    try {
      record.flow = build_flow(record.session)
    } catch (err: unknown) {
      record.model.id = previous
      throw internal_error(sdk, err)
    }
  }
  // Closing cancels the session's turn as session/cancel does, and waits for
  // its run to settle before the MCP servers close, so no tool call is left
  // talking to one. The session leaves memory, and the store keeps it.
  const close_session = async (record: AgentSession<i, o>): Promise<void> => {
    sessions.delete(record.session.id)
    cancel_turn(record)
    await record.last_turn?.settled
    await record.mcp.close()
  }
  return sdk
    .agent()
    .onConnect((connection) => {
      if (connected) throw new Error(ONE_CONNECTION)
      connected = true
      // The SDK aborts every request in flight as the connection closes,
      // which ends each turn, and then every session closes, so a stdio MCP
      // server doesn't outlive the editor that sent it.
      void connection.closed.then(() => Promise.all([...sessions.values()].map(close_session)))
    })
    .onRequest('initialize', (ctx) => {
      if (initialized) throw sdk.RequestError.invalidRequest(undefined, ONE_CONNECTION)
      initialized = true
      client_capabilities = ctx.params.clientCapabilities ?? {}
      return {
        protocolVersion: sdk.PROTOCOL_VERSION,
        agentInfo: identity,
        // Embedded context lets a file the user @-mentions arrive with its
        // text, rather than as a bare URI the flow has no way to read. The
        // agent advertises additional directories, which let a client widen
        // the workspace past `cwd`, unless the config sets
        // `additional_directories: false`.
        agentCapabilities: {
          loadSession: store !== undefined,
          promptCapabilities: { embeddedContext: true },
          ...(config.mcp_servers === true ? { mcpCapabilities: MCP_CAPABILITIES } : {}),
          sessionCapabilities: {
            close: {},
            ...(config.additional_directories === false ? {} : { additionalDirectories: {} }),
            ...(store === undefined ? {} : { list: {}, resume: {} }),
          },
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
      // `mcpServers` is ignored unless the config sets `mcp_servers`.
      const { cwd, mcpServers } = ctx.params
      const additional_directories = requested_directories(sdk, config, 'session/new', ctx.params.additionalDirectories)
      const record = await open_session(ctx.client, { id: randomUUID(), cwd, additional_directories, mcp_servers: mcpServers })
      return {
        sessionId: record.session.id,
        modes: mode_state(offer, record.modes.current()),
        configOptions: options_of(record),
      }
    })
    .onRequest('session/load', async (ctx) => {
      const record = await reopen(ctx.client, 'session/load', ctx.params)
      const send = sender(sdk, ctx.client, record.session.id)
      for (const entry of record.history) await send(replayed(entry))
      return reopened(ctx.client, record)
    })
    .onRequest('session/resume', async (ctx) => reopened(ctx.client, await reopen(ctx.client, 'session/resume', ctx.params)))
    .onRequest('session/list', async (ctx): Promise<ListSessionsResponse> => {
      if (store === undefined) throw sdk.RequestError.methodNotFound('session/list')
      const { cwd } = ctx.params
      const summaries = await store.list().catch((err: unknown) => {
        throw internal_error(sdk, err)
      })
      const listed = summaries
        .filter((summary) => cwd === undefined || cwd === null || summary.cwd === cwd)
        .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))
      return { sessions: listed.map(session_info) }
    })
    .onRequest('session/close', async (ctx) => {
      await close_session(session_of(ctx.params.sessionId))
      return {}
    })
    .onRequest('session/prompt', async (ctx) => {
      const { sessionId, prompt } = ctx.params
      const record = session_of(sessionId)
      try {
        return await prompt_turn(config, record, prompt, ctx.signal, sender(sdk, ctx.client, sessionId))
      } catch (err: unknown) {
        throw internal_error(sdk, err)
      } finally {
        await save_session(config, record)
      }
    })
    .onRequest('session/set_mode', async (ctx) => {
      const { sessionId, modeId } = ctx.params
      const record = session_of(sessionId)
      await record.modes.switch_to(requested_mode(sdk, offer, record.modes, modeId, 'modeId'))
      await save_session(config, record)
      return {}
    })
    .onRequest('session/set_config_option', async (ctx) => {
      const { sessionId, configId, value } = ctx.params
      const record = session_of(sessionId)
      if (configId === MODE_CONFIG_ID) {
        await record.modes.switch_to(requested_mode(sdk, offer, record.modes, value, 'value'))
      } else if (configId === MODEL_CONFIG_ID && models !== undefined) {
        switch_model(record, requested_model(sdk, models, value))
      } else {
        const known = models === undefined ? `the only one is ${MODE_CONFIG_ID}` : `the options are ${CONFIG_IDS}`
        throw sdk.RequestError.invalidParams({ configId }, `unknown config option ${configId}; ${known}`)
      }
      await save_session(config, record)
      return { configOptions: options_of(record) }
    })
    .onNotification('session/cancel', (ctx) => {
      const record = sessions.get(ctx.params.sessionId)
      if (record !== undefined) cancel_turn(record)
    })
}
