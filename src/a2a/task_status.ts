/**
 * How a run's resting place reads as an A2A task status.
 *
 * A drive that rests, and a task record that has fallen behind its run, both
 * need the same translation: done is `COMPLETED`, a client gate is
 * `INPUT_REQUIRED` with the gate's question, an external gate is `WORKING`
 * with a note that names the gate, and a failure is `FAILED`. Keeping it in
 * one place is what keeps `GetTask` and a live stream telling the same story.
 *
 * The gate a status belongs to rides in its message's metadata, as
 * `metadata.fascicle.gate`, beside the gate's `deadline_at` when it set one.
 */

import { randomUUID } from 'node:crypto'
import type { Message, Part, Task, TaskState, TaskStatus } from '@a2a-js/sdk'
import type { AgentExecutionEvent } from '@a2a-js/sdk/server'
import type { SchemaIssue } from '#core'
import { is_record } from '#schema'
import { data_part, text_part } from './parts.js'
import type { A2aServerSdk } from './sdk_loader.js'

export type Wire = A2aServerSdk['wire']

export type TaskIds = { readonly task_id: string; readonly context_id: string }

/**
 * Where a run stands, as far as a task's status is concerned.
 */
export type Rest =
  | { readonly kind: 'done'; readonly output: unknown }
  | { readonly kind: 'suspended'; readonly id: string; readonly payload: unknown; readonly deadline_at?: number }
  | { readonly kind: 'refused'; readonly gate: string; readonly issues: ReadonlyArray<SchemaIssue> }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'running' }

/**
 * The hooks that decide how a status reads, each with its default applied.
 */
export type StatusHooks = {
  readonly gates: (gate: string) => 'client' | 'external'
  readonly to_question: (gate: string, payload: unknown) => string | ReadonlyArray<Part>
  readonly to_failure: (err: unknown) => string
}

/**
 * The default `to_question`: a line that names the gate, then the gate's
 * payload as a data part, so the client sees what the run is asking about.
 */
export function default_question(gate: string, payload: unknown): ReadonlyArray<Part> {
  const line = text_part(`Waiting for input at "${gate}".`)
  return payload === undefined ? [line] : [line, data_part(payload)]
}

/**
 * The default `to_failure`: one line that says the task failed and nothing
 * about why.
 *
 * A failed task's status goes to whoever sent the message, and an error's
 * text can hold a connection string or a path that shouldn't leave the
 * server. The error itself goes to the agent's own trajectory or stderr.
 */
export function default_failure(): string {
  return 'The agent could not finish the task.'
}

/**
 * A `to_failure` that sends the error's own message, for an agent whose
 * callers are trusted with it.
 */
export function failure_message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Whether a task has ended, in a state no message or event can move it from.
 */
export function is_terminal(wire: Wire, task: Task): boolean {
  const state = task.status?.state
  return (
    state === wire.TaskState.TASK_STATE_COMPLETED ||
    state === wire.TaskState.TASK_STATE_FAILED ||
    state === wire.TaskState.TASK_STATE_CANCELED ||
    state === wire.TaskState.TASK_STATE_REJECTED
  )
}

/**
 * The gate a task's status belongs to, read from its message's metadata.
 */
export function gate_of(task: Task): string | undefined {
  const fascicle: unknown = task.status?.message?.metadata?.['fascicle']
  const gate = is_record(fascicle) ? fascicle['gate'] : undefined
  return typeof gate === 'string' ? gate : undefined
}

/**
 * A message from the agent on a task.
 */
function agent_message(
  wire: Wire,
  ids: TaskIds,
  parts: ReadonlyArray<Part>,
  metadata?: Record<string, unknown>,
): Message {
  return {
    messageId: randomUUID(),
    contextId: ids.context_id,
    taskId: ids.task_id,
    role: wire.Role.ROLE_AGENT,
    parts: [...parts],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  }
}

/**
 * A status stamped now, which is what `ListTasks` orders tasks by.
 */
export function status_of(state: TaskState, message?: Message): TaskStatus {
  return { state, message, timestamp: new Date().toISOString() }
}

/**
 * Wrap a status as the bus event that carries it.
 */
export function status_event(ids: TaskIds, status: TaskStatus): AgentExecutionEvent {
  return {
    kind: 'statusUpdate',
    data: { taskId: ids.task_id, contextId: ids.context_id, status, metadata: undefined },
  }
}

/**
 * The metadata that ties a status to its gate.
 */
function gate_metadata(gate: string, deadline_at?: number): Record<string, unknown> {
  return { fascicle: deadline_at === undefined ? { gate } : { gate, deadline_at } }
}

/**
 * The status of a run that waits at a gate: the client's question, or a note
 * that the run waits on something A2A doesn't carry.
 */
function gate_status(
  wire: Wire,
  hooks: StatusHooks,
  ids: TaskIds,
  rest: Extract<Rest, { readonly kind: 'suspended' }>,
): TaskStatus {
  const metadata = gate_metadata(rest.id, rest.deadline_at)
  if (hooks.gates(rest.id) === 'external') {
    const note = [text_part(`Waiting on "${rest.id}", which this agent's clients don't answer.`)]
    return status_of(wire.TaskState.TASK_STATE_WORKING, agent_message(wire, ids, note, metadata))
  }
  const question = hooks.to_question(rest.id, rest.payload)
  const parts = typeof question === 'string' ? [text_part(question)] : question
  return status_of(wire.TaskState.TASK_STATE_INPUT_REQUIRED, agent_message(wire, ids, parts, metadata))
}

/**
 * One line for each issue a gate's schema raised, with the path it sits at.
 */
function issue_lines(issues: ReadonlyArray<SchemaIssue>): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? []).map(String).join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * The task status for where a run rests, or `undefined` for a run that's
 * still being driven, which changes nothing by itself.
 */
export function status_for(wire: Wire, hooks: StatusHooks, ids: TaskIds, rest: Rest): TaskStatus | undefined {
  const state = wire.TaskState
  switch (rest.kind) {
    case 'done':
      return status_of(state.TASK_STATE_COMPLETED)
    case 'suspended':
      return gate_status(wire, hooks, ids, rest)
    case 'refused': {
      const text = `The answer to "${rest.gate}" was refused: ${issue_lines(rest.issues)}`
      const message = agent_message(wire, ids, [text_part(text)], gate_metadata(rest.gate))
      return status_of(state.TASK_STATE_INPUT_REQUIRED, message)
    }
    case 'failed':
      return status_of(state.TASK_STATE_FAILED, agent_message(wire, ids, [text_part(hooks.to_failure(rest.error))]))
    case 'canceled':
      return status_of(state.TASK_STATE_CANCELED, agent_message(wire, ids, [text_part('The task was canceled.')]))
    default:
      return undefined
  }
}
