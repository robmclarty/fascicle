/**
 * The task store the agent hands to the SDK: the caller's store, with the
 * runs kept in step behind it.
 *
 * Task records and runs live in two stores that can't share a transaction,
 * so the runs are the source of truth and every `load` brings the record up
 * to date. A task that isn't terminal takes on whatever its run did since
 * (another process drove it, or an outside event called `runs.resume`
 * directly), which keeps `GetTask` honest and repairs a record that a crash
 * left behind between the two writes. A task this process is driving is left
 * alone, since its own events are on their way.
 *
 * A terminal task needs no run. `FAILED` is final in A2A, while `durable`
 * would drive a failed run again at the next event, so the task's state
 * wins: a `save` that makes a task terminal deletes its run, and so does a
 * `load` that finds one. The run store only ever holds live tasks.
 *
 * A terminal task doesn't change either. A drive that another process
 * canceled runs on to its next resting place, and the SDK drops the status it
 * publishes there but would still fold its artifacts into the record. The
 * SDK loads a task before every write to it, so once a load has seen a task
 * ended, the store refuses every later `save` of it.
 *
 * `list` answers from the same records, so it brings each task on its page
 * up to date the way `load` does. The inner store applies a status filter
 * to the states it has stored, so a filtered `list` first brings up to date
 * the tasks the filter could misplace: the ones stored in a state a task
 * can still leave, up to `STALE_SCAN_LIMIT` of them in each such state.
 */

import { randomUUID } from 'node:crypto'
import type { ListTasksRequest, Part, Task, TaskStatus } from '@a2a-js/sdk'
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import type { DurableRunState, DurableRuns } from '#core'
import { gate_of, is_terminal, status_for } from './task_status.js'
import type { Rest, StatusHooks, Wire } from './task_status.js'

/** Where a task was last seen, and who it belongs to. */
export type Sighting = { readonly context: ServerCallContext; readonly context_id: string }

export type TaskRecordsConfig = {
  readonly wire: Wire
  readonly inner: TaskStore
  readonly runs: DurableRuns
  readonly hooks: StatusHooks
  readonly to_parts: (output: unknown) => ReadonlyArray<Part>
  /** Whether this process is driving a task right now. */
  readonly is_live: (task_id: string) => boolean
}

export type TaskRecords = {
  readonly store: TaskStore
  /**
   * Who each task this process has touched belongs to, until the task ends
   * or enough other tasks have been touched since.
   */
  readonly seen: ReadonlyMap<string, Sighting>
  /**
   * Resolves once a task is saved in `status`, or after `timeout_ms` when no
   * save comes, which is what happens when nothing reads the task's events.
   * Resolves at once for a task the store has seen ended.
   */
  readonly saved: (task_id: string, status: TaskStatus, timeout_ms: number) => Promise<void>
}

// How many finished tasks the store remembers, so that loading one again
// doesn't ask the run store to delete what's already gone, and so that a
// late write can't change it.
const REMEMBERED_LIMIT = 10_000

// How many live tasks the store remembers the owner of. Each sighting holds
// a request's context, headers included, so a task that a client walked
// away from can't keep one for the life of the process.
const SEEN_LIMIT = 10_000

// How many stored tasks a filtered `list` brings up to date in each state a
// task can still leave, most recently changed first. It bounds what one
// request costs: three list calls, and a task load and a run read for each
// task. It is also the largest page the SDK lets a store be asked for.
export const STALE_SCAN_LIMIT = 100

type Waiter = { readonly status: TaskStatus; readonly resolve: () => void }

/**
 * Where a stored run stands, in the terms a task status is built from.
 */
function rest_of(state: DurableRunState): Rest {
  if (state.kind === 'failed') return { kind: 'failed', error: new Error(state.error) }
  return state
}

/**
 * Whether a task's record already says what its run does, so that a load
 * leaves it alone. A waiting task matches its run when both name the same
 * gate, and a working one matches a run that's being driven.
 */
function is_current(wire: Wire, task: Task, rest: Rest, next: TaskStatus | undefined): boolean {
  if (next === undefined) return task.status?.state !== wire.TaskState.TASK_STATE_INPUT_REQUIRED
  if (rest.kind !== 'suspended') return false
  return task.status?.state === next.state && gate_of(task) === rest.id
}

/**
 * Add a task id to a set of remembered ones, emptying the set first once it
 * has grown to its limit. Forgetting costs a repeated store call, never a
 * wrong answer, since the next load of the task remembers it again.
 */
function remember(ids: Set<string>, task_id: string): void {
  if (ids.size >= REMEMBERED_LIMIT) ids.clear()
  ids.add(task_id)
}

/**
 * Note where a task was last seen, as the newest sighting, and forget the
 * oldest one once more than `limit` are held. A forgotten task is still
 * served: `resume` then needs `user` for a task that belongs to someone.
 */
export function sight(seen: Map<string, Sighting>, task_id: string, sighting: Sighting, limit: number): void {
  seen.delete(task_id)
  seen.set(task_id, sighting)
  if (seen.size <= limit) return
  for (const oldest of seen.keys()) {
    seen.delete(oldest)
    return
  }
}

/**
 * Wrap `config.inner` so that its task records follow their runs.
 */
export function task_records(config: TaskRecordsConfig): TaskRecords {
  const { wire, inner, runs, hooks } = config
  const seen = new Map<string, Sighting>()
  const ended = new Set<string>()
  const dropped = new Set<string>()
  const waiters = new Map<string, Set<Waiter>>()

  const drop_run = async (task_id: string): Promise<void> => {
    if (dropped.has(task_id)) return
    if (await runs.delete(task_id)) remember(dropped, task_id)
  }

  const settle = async (task: Task): Promise<void> => {
    if (!is_terminal(wire, task)) return
    seen.delete(task.id)
    remember(ended, task.id)
    await drop_run(task.id)
  }

  const announce = (task: Task): void => {
    for (const waiter of waiters.get(task.id) ?? []) {
      const same = waiter.status.state === task.status?.state && waiter.status.timestamp === task.status.timestamp
      if (same) waiter.resolve()
    }
  }

  const write = async (task: Task, context: ServerCallContext): Promise<void> => {
    if (ended.has(task.id)) return
    await inner.save(task, context)
    sight(seen, task.id, { context, context_id: task.contextId }, SEEN_LIMIT)
    announce(task)
    await settle(task)
  }

  // Bring a record up to date with its run: a new status, the output as an
  // artifact when the run finished, and the status message in the history,
  // which is where the SDK puts one.
  const reconcile = async (task: Task, context: ServerCallContext): Promise<Task> => {
    const state = await runs.get(task.id)
    if (state === undefined) return task
    const rest = rest_of(state)
    const ids = { task_id: task.id, context_id: task.contextId }
    const next = status_for(wire, hooks, ids, rest)
    if (is_current(wire, task, rest, next)) return task
    const status = next ?? { state: wire.TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() }
    const parts = rest.kind === 'done' ? config.to_parts(rest.output) : []
    const artifact = { artifactId: randomUUID(), name: '', description: '', parts: [...parts], metadata: undefined, extensions: [] }
    const updated: Task = {
      ...task,
      status,
      artifacts: parts.length === 0 ? task.artifacts : [...task.artifacts, artifact],
      history: status.message === undefined ? task.history : [...task.history, status.message],
    }
    await write(updated, context)
    return updated
  }

  const load: TaskStore['load'] = async (task_id, context) => {
    const task = await inner.load(task_id, context)
    if (task === undefined) return undefined
    if (is_terminal(wire, task)) {
      await settle(task)
      return task
    }
    sight(seen, task_id, { context, context_id: task.contextId }, SEEN_LIMIT)
    return config.is_live(task_id) ? task : reconcile(task, context)
  }

  // A listed task as its run has it now. The whole record is loaded, since
  // a page may come without artifacts and a reconcile writes the record
  // back. The page's own choice about artifacts holds for the answer.
  const refresh = async (listed: Task, with_artifacts: boolean, context: ServerCallContext): Promise<Task> => {
    if (is_terminal(wire, listed) || config.is_live(listed.id)) return listed
    const loaded = await load(listed.id, context)
    if (loaded === undefined) return listed
    return with_artifacts ? loaded : { ...loaded, artifacts: [] }
  }

  // Bring up to date the stored tasks that a status filter could hide or
  // wrongly show, and resolve the ids it read. A terminal record never
  // changes, so only a task stored as submitted, working, or waiting can be
  // in the wrong place. The scan keeps the request's tenant and context and
  // drops its time window, since a task that catches up gets a new timestamp.
  const catch_up = async (params: ListTasksRequest, context: ServerCallContext): Promise<Set<string>> => {
    const open = [wire.TaskState.TASK_STATE_SUBMITTED, wire.TaskState.TASK_STATE_WORKING, wire.TaskState.TASK_STATE_INPUT_REQUIRED]
    const pages = await Promise.all(
      open.map((status) =>
        inner.list(
          { ...params, status, pageSize: STALE_SCAN_LIMIT, pageToken: '', statusTimestampAfter: undefined, includeArtifacts: false },
          context,
        ),
      ),
    )
    const stale = pages.flatMap((page) => page.tasks).filter((task) => !config.is_live(task.id))
    await Promise.all(stale.map((task) => load(task.id, context)))
    return new Set(stale.map((task) => task.id))
  }

  const list: TaskStore['list'] = async (params, context) => {
    const filtered = params.status !== wire.TaskState.TASK_STATE_UNSPECIFIED
    const current = filtered ? await catch_up(params, context) : new Set<string>()
    const page = await inner.list(params, context)
    const tasks = await Promise.all(
      page.tasks.map(async (task) => (current.has(task.id) ? task : refresh(task, params.includeArtifacts === true, context))),
    )
    // A task past the scan's limit can still catch up here, into a state
    // the filter didn't ask for, and then it has no place on the page.
    return { ...page, tasks: filtered ? tasks.filter((task) => task.status?.state === params.status) : tasks }
  }

  const store: TaskStore = { load, save: write, list }

  const saved = (task_id: string, status: TaskStatus, timeout_ms: number): Promise<void> => {
    // The store refuses every save of a task it has seen ended, so no save is coming.
    if (ended.has(task_id)) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    const waiting = waiters.get(task_id) ?? new Set<Waiter>()
    waiters.set(task_id, waiting)
    const waiter: Waiter = { status, resolve }
    waiting.add(waiter)
    const timer = setTimeout(resolve, timeout_ms)
    timer.unref()
    return promise.finally(() => {
      clearTimeout(timer)
      waiting.delete(waiter)
      if (waiting.size === 0) waiters.delete(task_id)
    })
  }

  return { store, seen, saved }
}
