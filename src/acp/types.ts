/**
 * The types fascicle/acp speaks at its public surface. Protocol shapes stay
 * the SDK's own, imported as types where they're used, so naming them costs
 * a consumer without the optional peer nothing at runtime.
 */

import type { ClientCapabilities, ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'
import type { Step, TrajectoryEvent, TrajectoryLogger } from '#core'

/**
 * Where a model call's streamed text goes: the reply, the collapsed thought
 * block, or nowhere. A call with a `schema` streams raw JSON, and a flow with
 * several calls streams every draft, so a flow routes those away from the
 * reply by the call's `step_id`.
 */
export type AcpStreamRoute = 'message' | 'thought' | 'none'

export type AcpMapperOptions = {
  /** Prefixes every `toolCallId` so ids stay unique across turns; default: a random UUID. */
  readonly turn_id?: string | undefined
  /** Where each model call's text goes, by its `step_id`; default: `'message'` for every call. */
  readonly stream?: ((step_id: string) => AcpStreamRoute) | undefined
}

/**
 * What `to_session_updates` needs to know about the turn it maps, made once
 * per turn by `create_acp_mapper_state`.
 */
export type AcpMapperState = {
  readonly turn_id: string
  readonly stream: (step_id: string) => AcpStreamRoute
}

/**
 * One exchange in a session's history: the user's text, or the reply the
 * client was actually sent, so the history matches the thread the user sees.
 */
export type AcpHistoryEntry = {
  readonly role: 'user' | 'agent'
  readonly text: string
}

/**
 * Everything a flow sees of one prompt turn. `text` joins the prompt's text
 * blocks, writes a resource link or an embedded resource as its URI, and
 * appends each embedded resource's text after the prompt; `prompt` keeps the
 * raw ACP blocks for a flow that wants more.
 */
export type AcpTurn = {
  readonly session_id: string
  /** The working directory the client sent with `session/new`. */
  readonly cwd: string
  readonly text: string
  readonly prompt: ReadonlyArray<ContentBlock>
  /** Earlier turns, oldest first; a copy, so a flow can't change the session's own. */
  readonly history: ReadonlyArray<AcpHistoryEntry>
}

/**
 * A session as its flow builder sees it, made once per `session/new`.
 */
export type AcpSession = {
  readonly id: string
  /** The working directory the client sent with `session/new`. */
  readonly cwd: string
  /** What the client said it supports in `initialize`. */
  readonly client_capabilities: ClientCapabilities
}

type ServeAcpCommon<i, o> = {
  /**
   * The flow each prompt turn runs, or a function that builds one per
   * session, for a flow whose tools or approval handler close over it.
   */
  readonly flow: Step<i, o> | ((session: AcpSession) => Step<i, o>)
  /** Reported to the client as `agentInfo.name`. */
  readonly name: string
  /** Reported to the client as `agentInfo.version`; default: `'0.0.0'`. */
  readonly version?: string | undefined
  /**
   * The turn's reply when the flow streamed no message text; default: a
   * string as-is, anything else as JSON.
   */
  readonly to_text?: ((output: o) => string) | undefined
  /** Where each model call's text goes, by its `step_id`; default: `'message'`. */
  readonly stream?: ((step_id: string) => AcpStreamRoute) | undefined
  /** Maps each run event to the updates sent to the client; default: `to_session_updates`. */
  readonly to_updates?: ((event: TrajectoryEvent, state: AcpMapperState) => SessionUpdate[]) | undefined
  /** Disposed by `serve_acp` once the client disconnects; `acp_agent` leaves it alone. */
  readonly engine?: { readonly dispose: () => Promise<void> } | undefined
  /** Receives every run's events. Stdout carries the protocol, so it must never write there. */
  readonly trajectory?: TrajectoryLogger | undefined
  /** Aborts every active run when it fires. */
  readonly abort?: AbortSignal | undefined
}

/**
 * What `acp_agent` and `serve_acp` take. `to_input` maps a turn to the flow's
 * input and defaults to `turn.text`, so it's required unless the flow takes a
 * string.
 */
export type ServeAcpConfig<i, o> = ServeAcpCommon<i, o> &
  ([string] extends [i]
    ? { readonly to_input?: ((turn: AcpTurn) => i) | undefined }
    : { readonly to_input: (turn: AcpTurn) => i })
