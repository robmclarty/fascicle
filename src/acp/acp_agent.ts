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
 * mode switch, and answers `session/list`, `session/load`, and
 * `session/resume` from it. A loaded session gets a fresh flow from the
 * config, and the history it carries is what its next turn starts from.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentApp,
  AgentContext,
  ClientCapabilities,
  ListSessionsResponse,
  SessionInfo,
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import { create_card_sync, message_of, session_approver } from './approve.js'
import type { PermissionAsker } from './approve.js'
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
 * A session as the agent holds it: what a turn needs, its mode, and the
 * latest save, which the next save waits on so two never write at once.
 */
type AgentSession<i, o> = SessionRecord<i, o> & { readonly modes: SessionModes; saving: Promise<void> }

/** What a session starts from: its workspace, and for a stored one, where it left off. */
type SessionStart = {
  readonly id: string
  readonly cwd: string
  readonly additional_directories: ReadonlyArray<string>
  readonly stored?: AcpStoredSession | undefined
}

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
  const sdk = await load_acp_sdk()
  const sessions = new Map<string, AgentSession<i, o>>()
  const store = config.session_store
  let client_capabilities: ClientCapabilities = {}
  let connected = false
  let initialized = false
  const session_of = (sessionId: string): AgentSession<i, o> => {
    const record = sessions.get(sessionId)
    if (record !== undefined) return record
    throw sdk.RequestError.invalidParams({ sessionId }, `unknown session ${sessionId}; start one with session/new first`)
  }
  // The roots resolve once, here, so every containment check compares
  // against the same real paths for the life of the session.
  const open_session = async (client: AgentContext, start: SessionStart): Promise<AgentSession<i, o>> => {
    const { id, cwd, additional_directories, stored } = start
    const roots = await resolve_roots([cwd, ...additional_directories]).catch((err: unknown) => {
      throw sdk.RequestError.invalidParams({ cwd, additionalDirectories: additional_directories }, message_of(err))
    })
    const modes = session_modes(offer, sender(sdk, client, id), stored?.mode)
    const cards = create_card_sync()
    const approver = session_approver({ modes, cards, ask: permission_asker(sdk, client) })
    const session: AcpSession = {
      id,
      cwd,
      additional_directories,
      roots,
      client_capabilities,
      mode: modes.current,
      approve: (request) => approver(session, request),
    }
    const usage: SessionUsage = stored === undefined ? create_session_usage() : { ...stored.usage }
    try {
      const flow = typeof config.flow === 'function' ? config.flow(session) : config.flow
      const record: AgentSession<i, o> = {
        session,
        flow,
        history: structuredClone([...(stored?.history ?? [])]),
        cards,
        usage,
        last_turn: null,
        title: stored?.title ?? null,
        modes,
        saving: Promise.resolve(),
      }
      sessions.set(id, record)
      return record
    } catch (err: unknown) {
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
    params: { sessionId: string; cwd: string; additionalDirectories?: ReadonlyArray<string> | undefined },
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
    return live ?? open_session(client, { id: sessionId, cwd, additional_directories, stored })
  }
  // A reopened thread shows its title and its usage again, which the client
  // can't keep for an agent that restarted, and the answer carries its mode.
  const reopened = async (client: AgentContext, record: AgentSession<i, o>) => {
    const send = sender(sdk, client, record.session.id)
    if (record.title !== null && record.title !== '') await send({ sessionUpdate: 'session_info_update', title: record.title })
    if (config.context_window !== undefined && (record.usage.context_tokens > 0 || record.usage.priced)) {
      await send(usage_update(record.usage, config.context_window))
    }
    const mode = record.modes.current()
    return { modes: mode_state(offer, mode), configOptions: config_options(offer, mode) }
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
          loadSession: store !== undefined,
          promptCapabilities: { embeddedContext: true },
          sessionCapabilities: {
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
      // `mcpServers` is accepted and ignored until a flow can be handed them.
      const { cwd } = ctx.params
      const additional_directories = requested_directories(sdk, config, 'session/new', ctx.params.additionalDirectories)
      const { modes, session } = await open_session(ctx.client, { id: randomUUID(), cwd, additional_directories })
      return {
        sessionId: session.id,
        modes: mode_state(offer, modes.current()),
        configOptions: config_options(offer, modes.current()),
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
      if (configId !== MODE_CONFIG_ID) {
        throw sdk.RequestError.invalidParams(
          { configId },
          `unknown config option ${configId}; the only one is ${MODE_CONFIG_ID}`,
        )
      }
      await record.modes.switch_to(requested_mode(sdk, offer, record.modes, value, 'value'))
      await save_session(config, record)
      return { configOptions: config_options(offer, record.modes.current()) }
    })
    .onNotification('session/cancel', (ctx) => {
      const record = sessions.get(ctx.params.sessionId)
      if (record !== undefined) cancel_turn(record)
    })
}
