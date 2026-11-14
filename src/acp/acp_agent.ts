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
 * mode or model switch, and answers `session/list`, `session/load`,
 * `session/resume`, and `session/delete` from it. A loaded session gets a
 * fresh flow from the config, and the history it carries is what its next
 * turn starts from.
 *
 * A session holds what the client gave it until the client closes it with
 * `session/close` or drops the connection: its MCP servers, for an agent
 * that connects to them, are closed then, and a closed session leaves
 * memory, though not the store.
 *
 * A request that names a session the agent doesn't hold fails with -32002
 * and the id as `data.sessionId`, which is how the protocol has an agent
 * say that a session is gone, and what a host reads before it offers to
 * start the thread over. Given an `auth`, the agent offers a login and
 * refuses to start, load, or resume a session until the login is ready.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentApp,
  AgentContext,
  AuthMethod,
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
import type { McpConnections, McpWarning } from './mcp_servers.js'
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
import { session_page } from './session_list.js'
import { resolve_roots } from './tools/containment.js'
import type {
  AcpAuth,
  AcpHistoryEntry,
  AcpMode,
  AcpSession,
  AcpSessionSummary,
  AcpStoredSession,
  ServeAcpConfig,
} from './types.js'
import { create_session_usage, usage_update } from './usage.js'
import type { SessionUsage } from './usage.js'

type AcpSdk = Awaited<ReturnType<typeof load_acp_sdk>>

/**
 * A session as the agent holds it: what a turn needs, its mode, its model,
 * its MCP servers as the client sent them and as connected, the warnings
 * about them the client hasn't been shown, how many of its turns the store
 * keeps (null for a session whose turns aren't kept), and the latest save,
 * which the next save waits on so two never write at once. A deleted
 * session saves nothing more.
 */
type AgentSession<i, o> = SessionRecord<i, o> & {
  readonly modes: SessionModes
  readonly model: { id: string | undefined }
  mcp: McpConnections
  mcp_servers: ReadonlyArray<McpServer>
  /** Hands the session's flow builder another set of connections' tools. */
  readonly use_mcp: (connections: McpConnections) => void
  readonly notices: McpWarning[]
  turns: number | null
  saving: Promise<void>
  deleted: boolean
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

/** The id of the login every client is offered, which `authenticate` takes. */
const LOGIN_METHOD = 'login'

/** The id of the login a client runs in a terminal. */
const TERMINAL_LOGIN_METHOD = 'terminal-login'

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
 * The error for a request that names a session the agent doesn't hold:
 * -32002 with the id as `data.sessionId`, as the protocol asks. It's built
 * here because the SDK's own helper for it is newer than the oldest SDK the
 * peer range takes.
 */
function unknown_session(sdk: AcpSdk, sessionId: string): Error {
  return new sdk.RequestError(-32002, 'Resource not found', { sessionId })
}

/**
 * The error that tells a client the user has to log in first, which it
 * answers by offering the agent's login methods.
 */
function login_required(sdk: AcpSdk, auth: AcpAuth): Error {
  return new sdk.RequestError(-32000, `Authentication required: ${auth.instructions}`)
}

/**
 * The login methods an agent offers a client. Every client gets the one
 * the agent checks by itself, which is what the ACP registry looks for,
 * and a client that can run a terminal login also gets that one.
 */
function auth_methods(auth: AcpAuth | undefined, capabilities: ClientCapabilities): AuthMethod[] {
  if (auth === undefined) return []
  const shown = { name: auth.name, ...(auth.description === undefined ? {} : { description: auth.description }) }
  const agent_login: AuthMethod = { id: LOGIN_METHOD, ...shown }
  if (auth.terminal_args === undefined || capabilities.auth?.terminal !== true) return [agent_login]
  return [agent_login, { type: 'terminal', id: TERMINAL_LOGIN_METHOD, ...shown, args: [...auth.terminal_args] }]
}

/**
 * Whether two lists of MCP servers are the same list, entry for entry.
 */
function same_servers(a: ReadonlyArray<McpServer>, b: ReadonlyArray<McpServer>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
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
    ...(record.turns === null ? {} : { turns: record.turns }),
  }
}

/**
 * Save a session after the save before it: first each turn the store hasn't
 * been handed, for a store that keeps turns, then the session, whose count
 * of turns then reaches them. A session with no history yet isn't saved, so
 * a thread the user never wrote in doesn't fill the list, and neither is a
 * deleted one. A failed save is reported on stderr rather than failing the
 * turn the user already watched finish, and it leaves the session as it was
 * in the store.
 */
function save_session<i, o>(config: ServeAcpConfig<i, o>, record: AgentSession<i, o>): Promise<void> {
  const store = config.session_store
  const unsaved = record.unsaved_turns.splice(0)
  if (store === undefined || record.deleted || record.history.length === 0) return Promise.resolve()
  const { save_turn } = store
  const first = record.turns
  if (first !== null) record.turns = first + unsaved.length
  const snapshot = stored_session(record)
  record.saving = record.saving
    .then(async () => {
      if (first !== null && save_turn !== undefined) {
        await Promise.all(unsaved.map((updates, offset) => save_turn(snapshot.id, first + offset, updates)))
      }
      await store.save(snapshot)
    })
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
  const { auth } = config
  const session_of = (sessionId: string): AgentSession<i, o> => {
    const record = sessions.get(sessionId)
    if (record !== undefined) return record
    throw unknown_session(sdk, sessionId)
  }
  // A session that can't run shouldn't look started or restored, so each
  // request that opens one asks the login first.
  const require_login = async (): Promise<void> => {
    if (auth === undefined) return
    const ready = await Promise.resolve()
      .then(() => auth.ready())
      .catch((err: unknown) => {
        throw internal_error(sdk, err)
      })
    if (!ready) throw login_required(sdk, auth)
  }
  const connect = (servers: ReadonlyArray<McpServer>, cwd: string): Promise<McpConnections> =>
    config.mcp_servers === true
      ? connect_mcp_servers(servers, cwd, identity).catch((err: unknown) => {
          throw internal_error(sdk, err)
        })
      : Promise.resolve(NO_MCP)
  // A notice is a live message that only a client that asked for notices
  // may be sent. The warnings already went to stderr for every other one.
  const send_notices = async (client: AgentContext, record: AgentSession<i, o>): Promise<void> => {
    const warnings = record.notices.splice(0)
    if (client_capabilities.session?.notices === undefined || client_capabilities.session.notices === null) return
    const send = sender(sdk, client, record.session.id)
    for (const { title, description } of warnings) {
      await send({ sessionUpdate: 'notice', severity: 'warning', title, description })
    }
  }
  // Every option a session has, the mode first, as each answer and each
  // config option update reports them.
  const options_of = (record: AgentSession<i, o>): SessionConfigOption[] => [
    ...config_options(offer, record.modes.current()),
    ...model_options(models, record.model.id),
  ]
  const build_flow = async (session: AcpSession) => (typeof config.flow === 'function' ? config.flow(session) : config.flow)
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
    const mcp = await connect(start.mcp_servers, cwd)
    // The flow builder reads the tools off the session each time it runs, so
    // a session handed another list of servers builds its next flow on them.
    const tools = { gated: gated_mcp_tools(mcp.tools, () => session) }
    const session: AcpSession = {
      id,
      cwd,
      additional_directories,
      roots,
      client_capabilities,
      mode: modes.current,
      model: () => model.id,
      get mcp_tools() {
        return tools.gated
      },
      approve: (request) => approver(session, request),
    }
    const usage: SessionUsage = stored === undefined ? create_session_usage() : { ...stored.usage }
    // Turns are kept from a session's first one or not at all, so a session
    // stored without them goes on replaying its history's text.
    const keeps_turns = store?.save_turn !== undefined && store.load_turns !== undefined
    try {
      const record: AgentSession<i, o> = {
        session,
        flow: await build_flow(session),
        history: structuredClone([...(stored?.history ?? [])]),
        cards,
        usage,
        last_turn: null,
        title: stored?.title ?? null,
        unsaved_turns: [],
        modes,
        model,
        mcp,
        mcp_servers: start.mcp_servers,
        use_mcp: (connections) => {
          tools.gated = gated_mcp_tools(connections.tools, () => session)
        },
        notices: [...mcp.warnings],
        turns: keeps_turns ? (stored === undefined ? 0 : (stored.turns ?? null)) : null,
        saving: Promise.resolve(),
        deleted: false,
      }
      sessions.set(id, record)
      return record
    } catch (err: unknown) {
      await mcp.close()
      throw internal_error(sdk, err)
    }
  }
  // A live session handed another list of MCP servers connects to the new
  // list and builds its flow again, as a model switch does, so its next turn
  // has the new tools. The old connections close once the turn in flight has
  // settled, since its flow still calls them. A builder that throws leaves
  // the session on the servers it had.
  const switch_servers = async (record: AgentSession<i, o>, servers: ReadonlyArray<McpServer>): Promise<void> => {
    if (config.mcp_servers !== true || same_servers(record.mcp_servers, servers)) return
    const previous = record.mcp
    const next = await connect(servers, record.session.cwd)
    record.use_mcp(next)
    try {
      record.flow = await build_flow(record.session)
    } catch (err: unknown) {
      record.use_mcp(previous)
      await next.close()
      throw internal_error(sdk, err)
    }
    record.mcp = next
    record.mcp_servers = servers
    record.notices.push(...next.warnings)
    void Promise.resolve(record.last_turn?.settled).then(() => previous.close())
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
    await require_login()
    const { sessionId, cwd } = params
    const additional_directories = requested_directories(sdk, config, method, params.additionalDirectories)
    const live = sessions.get(sessionId)
    const stored = live === undefined ? await store.load(sessionId).catch((err: unknown) => {
      throw internal_error(sdk, err)
    }) : undefined
    const started_in = live?.session.cwd ?? stored?.cwd
    if (started_in === undefined) throw unknown_session(sdk, sessionId)
    if (started_in !== cwd) {
      throw sdk.RequestError.invalidParams(
        { sessionId, cwd },
        `session ${sessionId} started in ${started_in}; send that cwd with ${method}`,
      )
    }
    if (live === undefined) {
      return open_session(client, { id: sessionId, cwd, additional_directories, mcp_servers: params.mcpServers ?? [], stored })
    }
    if (params.mcpServers !== undefined) await switch_servers(live, params.mcpServers)
    return live
  }
  // A loaded thread is shown again from the turns the store kept, each as
  // the client saw it. A session whose turns weren't kept shows its
  // history's text, without its tool cards.
  const replay = async (client: AgentContext, record: AgentSession<i, o>): Promise<void> => {
    await record.saving
    const kept =
      record.turns !== null && record.turns > 0 && store?.load_turns !== undefined
        ? await store.load_turns(record.session.id, record.turns).catch((err: unknown) => {
            throw internal_error(sdk, err)
          })
        : undefined
    const send = sender(sdk, client, record.session.id)
    for (const update of kept?.flat() ?? record.history.map(replayed)) await send(update)
  }
  // A reopened thread shows its title and its usage again, which the client
  // can't keep for an agent that restarted, and the answer carries its mode
  // and its model. A host that keeps a running cost takes the usage sent
  // here as where the session stood, so its next turn isn't charged with
  // the whole total.
  const reopened = async (client: AgentContext, record: AgentSession<i, o>) => {
    await send_notices(client, record)
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
  const switch_model = async (record: AgentSession<i, o>, next: string): Promise<void> => {
    const previous = record.model.id
    record.model.id = next
    try {
      record.flow = await build_flow(record.session)
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
            ...(store?.delete === undefined ? {} : { delete: {} }),
          },
          ...(auth?.logout === undefined ? {} : { auth: { logout: {} } }),
        },
        // Without an `auth`, providers authenticate with what the launched
        // process can see, and the agent offers no method, since a client
        // can't act on a login the agent has no way to check.
        authMethods: auth_methods(auth, client_capabilities),
      }
    })
    .onRequest('authenticate', async (ctx) => {
      if (auth === undefined) return {}
      const { methodId } = ctx.params
      if (methodId !== LOGIN_METHOD) {
        throw sdk.RequestError.invalidParams({ methodId }, `unknown login method ${JSON.stringify(methodId)}; the method is ${LOGIN_METHOD}`)
      }
      await require_login()
      return {}
    })
    .onRequest('logout', async () => {
      if (auth?.logout === undefined) throw sdk.RequestError.methodNotFound('logout')
      await auth.logout().catch((err: unknown) => {
        throw internal_error(sdk, err)
      })
      return {}
    })
    .onRequest('session/new', async (ctx) => {
      await require_login()
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
      await replay(ctx.client, record)
      return reopened(ctx.client, record)
    })
    .onRequest('session/resume', async (ctx) => reopened(ctx.client, await reopen(ctx.client, 'session/resume', ctx.params)))
    .onRequest('session/list', async (ctx): Promise<ListSessionsResponse> => {
      if (store === undefined) throw sdk.RequestError.methodNotFound('session/list')
      const { cwd, cursor } = ctx.params
      const summaries = await store.list().catch((err: unknown) => {
        throw internal_error(sdk, err)
      })
      const page = session_page(summaries, cwd, cursor)
      if (page === undefined) {
        throw sdk.RequestError.invalidParams({ cursor }, "that cursor isn't one this agent gave out; send session/list without a cursor to start over")
      }
      return {
        sessions: page.sessions.map(session_info),
        ...(page.next_cursor === undefined ? {} : { nextCursor: page.next_cursor }),
      }
    })
    .onRequest('session/delete', async (ctx) => {
      if (store?.delete === undefined) throw sdk.RequestError.methodNotFound('session/delete')
      const { sessionId } = ctx.params
      const live = sessions.get(sessionId)
      if (live !== undefined) {
        // A turn that ends while the session is being deleted would save it
        // back, so the session stops saving before it closes.
        live.deleted = true
        await close_session(live)
        await live.saving
      }
      await store.delete(sessionId).catch((err: unknown) => {
        throw internal_error(sdk, err)
      })
      return {}
    })
    .onRequest('session/close', async (ctx) => {
      await close_session(session_of(ctx.params.sessionId))
      return {}
    })
    .onRequest('session/prompt', async (ctx) => {
      const { sessionId, prompt } = ctx.params
      const record = session_of(sessionId)
      // A warning about a server left out of a new session waits for the
      // first prompt, since the client didn't know the session's id while
      // the session was being made.
      await send_notices(ctx.client, record)
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
        await switch_model(record, requested_model(sdk, models, value))
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
