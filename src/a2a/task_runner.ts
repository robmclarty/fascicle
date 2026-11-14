/**
 * Drives the durable run behind each A2A task.
 *
 * A task is a durable run, and the task id is the run id. A message with no
 * task starts a run, a message for a task that waits at a client gate
 * resumes it with the client's answer, and an outside event resumes it
 * through `resume`. Every drive records model chunks, maps the run's events
 * onto the task's event bus, and can be aborted by a cancel. Where the drive
 * comes to rest decides the task's state (see task_status.ts).
 *
 * The SDK's request handler owns the bus and writes each event to the task
 * store as the request reads it. A drive that the SDK didn't start (an
 * outside event) writes its events through the SDK's `ResultManager`
 * instead, and publishes them as well when a client is subscribed.
 *
 * One drive at a time holds a task in this process. The handle it holds is
 * what a cancel aborts, what `close` waits for, and what makes a second
 * message find the task working. A drive lets go only once its resting
 * status has reached the task store, so a `GetTask` that lands in between
 * reads the record as the drive left it and not as its run alone suggests.
 */

import { randomUUID } from 'node:crypto'
import type { Message, Part, Task, TaskStatus } from '@a2a-js/sdk'
import type {
  AgentExecutionEvent,
  AgentExecutor,
  ExecutionEventBusManager,
  RequestContext,
  ServerCallContext,
  TaskStore,
} from '@a2a-js/sdk/server'
import { aborted_error, resume_validation_error } from '#core'
import type { DurableOutcome, DurableRunOptions, DurableRuns, TrajectoryEvent, TrajectoryLogger } from '#core'
import { a2a_error } from './errors.js'
import { data_of, files_of, text_of } from './parts.js'
import type { A2aServerSdk } from './sdk_loader.js'
import type { TaskRecords } from './task_records.js'
import { is_terminal, status_event, status_for, status_of } from './task_status.js'
import type { Rest, StatusHooks, TaskIds } from './task_status.js'
import { create_a2a_mapper_state, end_task_events, has_streamed, to_task_events } from './to_task_events.js'
import type { A2aAgentConfig, A2aHistoryEntry, A2aResumeOptions, A2aTurn, A2aUser } from './types.js'

/**
 * One task's hold on this process: the drive that has it, or the message
 * that's about to start one.
 */
export type Hold = {
  readonly abort: AbortController
  /** Set by a cancel, so the drive ends the task `CANCELED` however it settles. */
  canceled: boolean
  /** Set once a drive has taken the hold a message was admitted with. */
  taken: boolean
  readonly settled: Promise<void>
  readonly release: () => void
}

export type Holds = Map<string, Hold>

export type TaskRunnerConfig<i, o> = {
  readonly sdk: A2aServerSdk
  readonly config: A2aAgentConfig<i, o>
  readonly runs: DurableRuns
  readonly records: TaskRecords
  readonly holds: Holds
  readonly hooks: StatusHooks
  readonly to_parts: (output: unknown) => ReadonlyArray<Part>
  readonly buses: ExecutionEventBusManager
}

export type TaskRunner = {
  readonly executor: AgentExecutor
  readonly resume: (
    task_id: string,
    resume_data: Readonly<Record<string, unknown>>,
    options?: A2aResumeOptions,
  ) => Promise<void>
  /** Aborts every drive and waits for each one to settle. */
  readonly close: () => Promise<void>
}

type Publish = (event: AgentExecutionEvent) => void

type Begin<o> = (options: DurableRunOptions) => Promise<DurableOutcome<o>>

const DEFAULT_HISTORY_LIMIT = 20
const MAX_HISTORY_LIMIT = 100

// How long a drive waits for its resting status to reach the task store
// before it lets go of the task anyway.
const SAVE_WAIT_MS = 2_000

/**
 * Take a hold on `task_id` for a drive, or for a message on its way to one.
 */
export function take_hold(holds: Holds, task_id: string): Hold {
  const { promise, resolve } = Promise.withResolvers<void>()
  const hold: Hold = {
    abort: new AbortController(),
    canceled: false,
    taken: false,
    settled: promise,
    release: () => {
      if (holds.get(task_id) === hold) holds.delete(task_id)
      resolve()
    },
  }
  holds.set(task_id, hold)
  return hold
}

/**
 * A logger that hands every event of a drive to `on_event`, spans included,
 * and passes each call on to the config's own logger when it has one.
 */
function drive_logger(on_event: (event: TrajectoryEvent) => void, sink: TrajectoryLogger | undefined): TrajectoryLogger {
  return {
    record: (event) => {
      sink?.record(event)
      on_event(event)
    },
    start_span: (name, meta) => {
      const span_id = sink?.start_span(name, meta) ?? `${name}:${randomUUID().slice(0, 8)}`
      on_event({ kind: 'span_start', span_id, name, ...meta })
      return span_id
    },
    end_span: (span_id, meta) => {
      sink?.end_span(span_id, meta)
      on_event({ kind: 'span_end', span_id, ...meta })
    },
  }
}

/**
 * A gate's refusal of its answer, read from the error a drive threw, or
 * `undefined` for any other error. `durable` has already put the run back at
 * the gate by the time the error surfaces.
 */
function refusal_of(err: unknown): Rest | undefined {
  if (!(err instanceof resume_validation_error) || err.suspend_id === undefined) return undefined
  return { kind: 'refused', gate: err.suspend_id, issues: err.issues }
}

/**
 * The caller behind a request, as a flow sees them.
 */
function user_of(context: ServerCallContext): A2aUser {
  return { name: context.user?.userName ?? '', authenticated: context.user?.isAuthenticated ?? false }
}

/**
 * The two sides of one earlier task: what the user opened it with, and the
 * text it ended with (its artifacts' text, or else its status message).
 */
function exchange_of(sdk: A2aServerSdk, task: Task): A2aHistoryEntry[] {
  const opened = task.history.find((message) => message.role === sdk.wire.Role.ROLE_USER)
  const reply =
    task.artifacts.map((artifact) => text_of(artifact.parts)).filter((text) => text !== '').join('\n') ||
    text_of(task.status?.message?.parts ?? [], '\n')
  const entries: A2aHistoryEntry[] = []
  if (opened !== undefined) entries.push({ task_id: task.id, role: 'user', text: text_of(opened.parts, '\n') })
  if (reply !== '') entries.push({ task_id: task.id, role: 'agent', text: reply })
  return entries
}

/**
 * Build the runner that drives tasks for one agent.
 */
export function task_runner<i, o>(deps: TaskRunnerConfig<i, o>): TaskRunner {
  const { sdk, config, runs, records, holds, hooks, buses } = deps
  const state = sdk.wire.TaskState
  const store: TaskStore = records.store

  // The earlier exchanges of a context, oldest first, from the most recent
  // tasks the caller has in it.
  const history_of = async (ids: TaskIds, context: ServerCallContext): Promise<A2aHistoryEntry[]> => {
    const limit = Math.min(MAX_HISTORY_LIMIT, Math.max(0, Math.trunc(config.history_limit ?? DEFAULT_HISTORY_LIMIT)))
    if (limit === 0) return []
    const listed = await store.list(
      {
        tenant: context.tenant ?? '',
        contextId: ids.context_id,
        status: state.TASK_STATE_UNSPECIFIED,
        // One more than the limit, since the turn's own task may be among them.
        pageSize: Math.min(MAX_HISTORY_LIMIT, limit + 1),
        pageToken: '',
        statusTimestampAfter: undefined,
        includeArtifacts: true,
      },
      context,
    )
    const earlier = listed.tasks.filter((task) => task.id !== ids.task_id).slice(0, limit)
    return earlier.toReversed().flatMap((task) => exchange_of(sdk, task))
  }

  const turn_of = async (ids: TaskIds, message: Message, context: ServerCallContext): Promise<A2aTurn> => ({
    task_id: ids.task_id,
    context_id: ids.context_id,
    text: text_of(message.parts, '\n'),
    data: data_of(message.parts),
    files: files_of(message.parts),
    message,
    history: await history_of(ids, context),
    user: user_of(context),
  })

  const input_of = (turn: A2aTurn): i => {
    if (config.to_input !== undefined) return config.to_input(turn)
    // A2aAgentConfig allows a missing `to_input` only when the flow takes a string.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return turn.text as i
  }

  const answer_of = (turn: A2aTurn, gate: string): unknown => {
    if (config.to_resume !== undefined) return config.to_resume(turn, gate)
    return turn.data.length > 0 ? turn.data[0] : turn.text
  }

  // Run one drive and publish what it comes to. Resolves the status the
  // drive rested on, or `undefined` when another process holds the run.
  const drive = async (ids: TaskIds, hold: Hold, publish: Publish, begin: Begin<o>): Promise<TaskStatus | undefined> => {
    const mapper = create_a2a_mapper_state({ ...ids, stream: config.stream })
    const to_events = config.to_events ?? to_task_events
    const logger = drive_logger((event) => {
      for (const mapped of to_events(event, mapper)) publish(mapped)
    }, config.trajectory)
    let rest: Rest | undefined
    try {
      const outcome = await begin({
        record_chunks: true,
        trajectory: logger,
        abort: hold.abort.signal,
        install_signal_handlers: false,
      })
      if (outcome.kind !== 'busy') rest = outcome
    } catch (err) {
      rest = refusal_of(err) ?? { kind: 'failed', error: err }
    }
    if (hold.canceled) rest = { kind: 'canceled' }
    // Text that streamed is the output already, unless the output is more
    // than text, in which case its parts close the artifact.
    const parts = rest?.kind === 'done' && !(has_streamed(mapper) && typeof rest.output === 'string') ? deps.to_parts(rest.output) : []
    for (const closing of end_task_events(mapper, parts)) publish(closing)
    const status = rest === undefined ? undefined : status_for(sdk.wire, hooks, ids, rest)
    if (status === undefined) return undefined
    const saved = records.saved(ids.task_id, status, SAVE_WAIT_MS)
    publish(status_event(ids, status))
    await saved
    return status
  }

  // Let go of a task whose drive has rested. A task that ended elsewhere
  // while this process drove it (a cancel on another host) still has a run,
  // which the load deletes.
  const finish = async (ids: TaskIds, context: ServerCallContext, hold: Hold): Promise<void> => {
    try {
      await store.load(ids.task_id, context)
    } finally {
      hold.release()
    }
  }

  const execute = async (request: RequestContext, bus: Parameters<AgentExecutor['execute']>[1]): Promise<void> => {
    const ids: TaskIds = { task_id: request.taskId, context_id: request.contextId }
    const hold = holds.get(ids.task_id) ?? take_hold(holds, ids.task_id)
    hold.taken = true
    const publish: Publish = (event) => {
      bus.publish(event)
    }
    const message = request.userMessage
    const opening: Task = request.task ?? {
      id: ids.task_id,
      contextId: ids.context_id,
      status: status_of(state.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [message],
      metadata: undefined,
    }
    try {
      publish({ kind: 'task', data: opening })
      publish(status_event(ids, status_of(state.TASK_STATE_WORKING)))
      await drive(ids, hold, publish, async (options) => {
        const turn = await turn_of(ids, message, request.context)
        if (request.task === undefined) return runs.start(ids.task_id, config.flow, input_of(turn), options)
        const run = await runs.get(ids.task_id)
        const data = run?.kind === 'suspended' ? { [run.id]: answer_of(turn, run.id) } : {}
        return runs.resume(ids.task_id, config.flow, data, options)
      })
    } finally {
      await finish(ids, request.context, hold)
    }
  }

  const cancel = async (task_id: string, bus: Parameters<AgentExecutor['cancelTask']>[1]): Promise<void> => {
    const hold = holds.get(task_id)
    if (hold !== undefined) {
      hold.canceled = true
      hold.abort.abort(new aborted_error('the task was canceled'))
      await hold.settled
      return
    }
    // No drive holds the task, so it waits at a client gate with its bus
    // kept open, and the cancel is this one event.
    const sighting = records.seen.get(task_id)
    const ids: TaskIds = { task_id, context_id: sighting?.context_id ?? '' }
    const status = status_for(sdk.wire, hooks, ids, { kind: 'canceled' })
    if (status !== undefined) bus.publish(status_event(ids, status))
    if (sighting !== undefined) buses.cleanupByTaskId(task_id, sighting.context)
  }

  // Wait until no drive holds the task, then load it, and repeat when a
  // drive took it during the load.
  const load_free = async (task_id: string, context: ServerCallContext): Promise<Task | undefined> => {
    for (;;) {
      const held = holds.get(task_id)
      if (held !== undefined) {
        await held.settled
        continue
      }
      const task = await store.load(task_id, context)
      if (!holds.has(task_id)) return task
    }
  }

  const resume: TaskRunner['resume'] = async (task_id, resume_data, options = {}) => {
    const user = options.user
    const context =
      user === undefined
        ? (records.seen.get(task_id)?.context ?? new sdk.server.ServerCallContext())
        : new sdk.server.ServerCallContext({ user: { isAuthenticated: user.authenticated, userName: user.name } })
    const task = await load_free(task_id, context)
    if (task === undefined) {
      throw new a2a_error(
        `no task ${task_id} to resume: check the id, and pass \`user\` when the task belongs to an authenticated caller`,
        { task_id },
      )
    }
    if (is_terminal(sdk.wire, task)) return
    const ids: TaskIds = { task_id, context_id: task.contextId }
    const hold = take_hold(holds, task_id)
    hold.taken = true
    const bus = buses.getByTaskId(task_id, context)
    const writer = new sdk.server.ResultManager(store, context)
    let writes: Promise<void> = Promise.resolve()
    const publish: Publish = (event) => {
      writes = writes.then(() => writer.processEvent(event))
      bus?.publish(event)
    }
    try {
      publish(status_event(ids, status_of(state.TASK_STATE_WORKING)))
      const status = await drive(ids, hold, publish, (run_options) =>
        runs.resume(task_id, config.flow, resume_data, run_options),
      )
      await writes
      // A bus stays open only for a task that waits on its client.
      if (bus !== undefined && status?.state !== state.TASK_STATE_INPUT_REQUIRED) {
        bus.finished()
        buses.cleanupByTaskId(task_id, context)
      }
    } finally {
      await finish(ids, context, hold)
    }
  }

  const close = async (): Promise<void> => {
    const open = [...holds.values()]
    for (const hold of open) hold.abort.abort(new aborted_error('the agent closed while the task was running'))
    await Promise.all(open.map((hold) => hold.settled))
  }

  return { executor: { execute, cancelTask: cancel }, resume, close }
}
