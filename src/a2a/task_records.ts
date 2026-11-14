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
 */

import { randomUUID } from 'node:crypto'
import type { Part, Task, TaskStatus } from '@a2a-js/sdk'
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
  /** Who each task this process has touched belongs to, until the task ends. */
  readonly seen: ReadonlyMap<string, Sighting>
  /**
   * Resolves once a task is saved in `status`, or after `timeout_ms` when no
   * save comes, which is what happens when nothing reads the task's events.
   */
  readonly saved: (task_id: string, status: TaskStatus, timeout_ms: number) => Promise<void>
}

// How many finished tasks the store remembers, so that loading one again
// doesn't ask the run store to delete what's already gone, and so that a
// late write can't change it.
const REMEMBERED_LIMIT = 10_000

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
    seen.set(task.id, { context, context_id: task.contextId })
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

  const store: TaskStore = {
    load: async (task_id, context) => {
      const task = await inner.load(task_id, context)
      if (task === undefined) return undefined
      if (is_terminal(wire, task)) {
        await settle(task)
        return task
      }
      seen.set(task_id, { context, context_id: task.contextId })
      return config.is_live(task_id) ? task : reconcile(task, context)
    },
    save: write,
    list: (params, context) => inner.list(params, context),
  }

  const saved = (task_id: string, status: TaskStatus, timeout_ms: number): Promise<void> => {
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
