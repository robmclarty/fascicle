/**
 * The types fascicle/a2a speaks at its public surface. Protocol shapes
 * (`Message`, `Part`, `Artifact`, `AgentCard`, and the rest) stay the SDK's
 * own, imported as types where they're used, so naming them costs a consumer
 * without the optional peer nothing at runtime.
 */

import type { AgentCard, Artifact, Message, Part, SecurityRequirement, SecurityScheme } from '@a2a-js/sdk'
import type { A2ARequestHandler, AgentExecutionEvent, TaskStore } from '@a2a-js/sdk/server'
import type { DurableRuns, Step, TrajectoryEvent, TrajectoryLogger } from '#core'

/** The caller of a request, as `authenticate` names them. */
export type A2aUser = {
  /** Scopes the caller's task records, so it has to be stable for one caller. Empty for an anonymous one. */
  readonly name: string
  readonly authenticated: boolean
}

/**
 * A file part of a message, as the client sent it. The agent fetches
 * nothing, so a part that carries a URL reaches the flow as that URL.
 */
export type A2aFile = {
  readonly filename: string
  readonly media_type: string
  readonly url?: string | undefined
  /** Raw bytes, base64-encoded so that they survive a trip through a store. */
  readonly base64?: string | undefined
}

/**
 * One side of an earlier exchange in a turn's context: what the user sent to
 * open a task, or the text that task ended with.
 */
export type A2aHistoryEntry = {
  readonly task_id: string
  readonly role: 'user' | 'agent'
  readonly text: string
}

/**
 * Everything a flow sees of one message. `text` joins the message's text
 * parts, `data` holds its data parts, and `message` keeps the raw A2A
 * message for a flow that wants more.
 */
export type A2aTurn = {
  readonly task_id: string
  readonly context_id: string
  /** The message's text parts, joined. */
  readonly text: string
  /** Its data parts, in order. */
  readonly data: ReadonlyArray<unknown>
  /** Its file parts, as sent. The agent fetches nothing. */
  readonly files: ReadonlyArray<A2aFile>
  /** The raw A2A message, for a flow that wants more. */
  readonly message: Message
  /** Earlier exchanges in the context, oldest first; a copy. */
  readonly history: ReadonlyArray<A2aHistoryEntry>
  readonly user: A2aUser
}

/** One thing the agent can do, as its card lists it. */
export type A2aSkill = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags?: ReadonlyArray<string> | undefined
  readonly examples?: ReadonlyArray<string> | undefined
  readonly input_modes?: ReadonlyArray<string> | undefined
  readonly output_modes?: ReadonlyArray<string> | undefined
}

/**
 * What the agent says about itself at `/.well-known/agent-card.json`. The
 * card lists one interface, JSON-RPC at `url`, and advertises streaming
 * without push notifications or an extended card.
 */
export type A2aCard = {
  readonly name: string
  readonly description: string
  /** Default: `'0.0.0'`. */
  readonly version?: string | undefined
  /** The URL that clients reach the agent at, which a server behind a proxy can't work out for itself. */
  readonly url: string
  readonly skills: ReadonlyArray<A2aSkill>
  readonly provider?: { readonly organization: string; readonly url: string } | undefined
  readonly documentation_url?: string | undefined
  readonly icon_url?: string | undefined
  /** Advertised as given. `authenticate` is what checks a request. */
  readonly security_schemes?: Readonly<Record<string, SecurityScheme>> | undefined
  readonly security_requirements?: ReadonlyArray<SecurityRequirement> | undefined
  /** Default: `['text/plain', 'application/json']`. */
  readonly input_modes?: ReadonlyArray<string> | undefined
  /** Default: `['text/plain', 'application/json']`. */
  readonly output_modes?: ReadonlyArray<string> | undefined
}

/** Where a model call's streamed text goes: the drive's artifact, or nowhere. */
export type A2aStreamRoute = 'artifact' | 'none'

export type A2aMapperOptions = {
  readonly task_id: string
  readonly context_id: string
  /** The id of the artifact the drive streams into; default: a random UUID. */
  readonly artifact_id?: string | undefined
  /** Where each model call's text goes, by its `step_id`; default: `'artifact'` for every call. */
  readonly stream?: ((step_id: string) => A2aStreamRoute) | undefined
}

/**
 * What `to_task_events` needs to know about the drive it maps, made once per
 * drive by `create_a2a_mapper_state`.
 */
/** One step that a resumed drive is running again. */
export type A2aReplay = {
  readonly step_id: string
  /** The gates still ahead of the drive, each removed as the drive passes it. */
  readonly gates: Set<string>
}

export type A2aMapperState = {
  readonly task_id: string
  readonly context_id: string
  readonly artifact_id: string
  readonly stream: (step_id: string) => A2aStreamRoute
  /**
   * The steps a resumed drive is running again, by the span each replay
   * runs in, with the gates the drive hadn't reached when the step began.
   * Their text already reached the client, so `to_task_events` drops it
   * until the span ends or the drive has passed the last of those gates.
   */
  readonly replaying: Map<string, A2aReplay>
  /**
   * The newest text chunk, held back until the next one arrives or the drive
   * ends, since only the artifact's last chunk carries `lastChunk`.
   */
  pending: string | undefined
  /** How many chunks of the artifact have gone out. */
  sent: number
}

type A2aAgentCommon<i, o> = {
  /** The flow each task runs. */
  readonly flow: Step<i, o>
  readonly card: A2aCard
  /** Where the tasks' runs live; default: `durable({ store: memory_store() })`. */
  readonly runs?: DurableRuns | undefined
  /** Where the task records live; default: the SDK's `InMemoryTaskStore`. */
  readonly task_store?: TaskStore | undefined
  /** Who answers each gate; default: `'client'`. */
  readonly gates?: ((gate: string) => 'client' | 'external') | undefined
  /** A client's answer as the gate's resume data; default: the first data part, else the text. */
  readonly to_resume?: ((turn: A2aTurn, gate: string) => unknown) | undefined
  /** What a client gate asks; default: a line that names the gate, then its payload as a data part. */
  readonly to_question?: ((gate: string, payload: unknown) => string | ReadonlyArray<Part>) | undefined
  /** The output as artifact parts; default: a string as text, anything else as data. */
  readonly to_parts?: ((output: o) => ReadonlyArray<Part>) | undefined
  /**
   * A failed task's status text, which the caller reads; default: `The agent
   * could not finish the task.`, whatever the error was. Pass
   * `failure_message` to send the error's own message instead. The error
   * itself always goes to `trajectory`, or to stderr without one.
   */
  readonly to_failure?: ((err: unknown) => string) | undefined
  /** Where each model call's text goes, by its `step_id`; default: `'artifact'`. */
  readonly stream?: ((step_id: string) => A2aStreamRoute) | undefined
  /** Maps each run event to bus events; default: `to_task_events`. */
  readonly to_events?: ((event: TrajectoryEvent, state: A2aMapperState) => AgentExecutionEvent[]) | undefined
  /** How many earlier tasks in a context `turn.history` reads, up to 100; default: 20. */
  readonly history_limit?: number | undefined
  /** Checks each JSON-RPC request, and null answers 401; default: every caller is anonymous. */
  readonly authenticate?: ((request: Request) => A2aUser | null | Promise<A2aUser | null>) | undefined
  /** The path that takes JSON-RPC; default: `'/'`. */
  readonly rpc_path?: string | undefined
  /** The largest request body, in bytes; default: 1_048_576. */
  readonly max_body_bytes?: number | undefined
  /** How many drives may run at once; default: 8. */
  readonly max_drives?: number | undefined
  /**
   * How often a drive reads its task's record for a cancel that another
   * process took, in milliseconds; default: 2_000. 0 turns the check off,
   * for an agent that is the only one over its stores.
   */
  readonly cancel_poll_ms?: number | undefined
  /** Receives every drive's events, and an `a2a_task_failed` event for each drive that failed. */
  readonly trajectory?: TrajectoryLogger | undefined
}

/**
 * What `a2a_agent` takes. `to_input` maps a turn to the flow's input and
 * defaults to `turn.text`, so it's required unless the flow takes a string.
 */
export type A2aAgentConfig<i, o> = A2aAgentCommon<i, o> &
  ([string] extends [i]
    ? { readonly to_input?: ((turn: A2aTurn) => i) | undefined }
    : { readonly to_input: (turn: A2aTurn) => i })

export type A2aResumeOptions = {
  /**
   * The caller whose task this is. An agent with an `authenticate` hook
   * keeps each caller's tasks apart, so a `resume` that reaches a task this
   * process hasn't seen yet has to say whose it is; default: the caller the
   * agent last saw the task under, or the anonymous one.
   */
  readonly user?: A2aUser | undefined
}

export type A2aAgent = {
  /** The agent card and JSON-RPC, as a web fetch handler. */
  readonly fetch: (request: Request) => Promise<Response>
  /** Hands an outside event to a task's run and records what follows. */
  readonly resume: (
    task_id: string,
    resume_data: Readonly<Record<string, unknown>>,
    options?: A2aResumeOptions,
  ) => Promise<void>
  /** The SDK's handler, for a caller who mounts the REST or gRPC binding itself. */
  readonly request_handler: A2ARequestHandler
  readonly card: AgentCard
  /** Aborts every drive and waits for each one to settle. The stores stay open. */
  readonly close: () => Promise<void>
}

/**
 * What `serve_a2a` takes: the agent's config, and where to listen.
 */
export type ServeA2aConfig<i, o> = A2aAgentConfig<i, o> & {
  /** The port to listen on, or 0 for any free one. */
  readonly port: number
  /** Default: `'127.0.0.1'`. */
  readonly host?: string | undefined
  /** Disposed once the server has closed. */
  readonly engine?: { readonly dispose: () => Promise<void> } | undefined
}

/** What `serve_a2a` resolves once it's listening. */
export type A2aServer = {
  /** The address the server bound, such as `http://127.0.0.1:41241`. */
  readonly url: string
  /** Hands an outside event to a task's run, as the agent's own `resume` does. */
  readonly resume: A2aAgent['resume']
  /** Stops taking connections, closes the agent, and disposes the engine. */
  readonly close: () => Promise<void>
}

export type SqliteTaskStoreConfig = {
  /** The database file, or `':memory:'` for one that lasts as long as the store. */
  readonly path: string
  /** How long a write waits on another connection's lock, in milliseconds; default: 5_000. */
  readonly timeout_ms?: number | undefined
}

/** What an `a2a_step` sends: text, or text and data, in a conversation it may continue. */
export type A2aRequest =
  | string
  | {
      readonly text?: string | undefined
      readonly data?: unknown
      /** Continues the conversation that an earlier result's `context_id` names. */
      readonly context_id?: string | undefined
    }

/** What an `a2a_step` resolves once the remote task completes. */
export type A2aResult = {
  readonly task_id: string
  readonly context_id: string
  /** The artifacts' text parts, joined. */
  readonly text: string
  /** Their data parts, in order. */
  readonly data: ReadonlyArray<unknown>
  readonly artifacts: ReadonlyArray<Artifact>
}

export type A2aStepConfig = {
  readonly id: string
  /** The agent's base URL. The card is read from `/.well-known/agent-card.json` under it. */
  readonly url: string
  /**
   * Sent with every request to the origin of `url`; a function runs before each
   * one, for a token that refreshes. A request that the agent's card points at
   * another origin goes out without them.
   */
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() => Promise<Readonly<Record<string, string>>>)
    | undefined
  /** Whether to read the reply as a stream; default: whatever the card says. */
  readonly stream?: boolean | undefined
  readonly name?: string | undefined
  readonly description?: string | undefined
}
