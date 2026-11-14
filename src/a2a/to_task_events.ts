/**
 * Maps a drive's events onto A2A task events.
 *
 * A drive runs with `record_chunks`, so each `model_call` records
 * `model_chunk` events carrying the engine's `StreamChunk`, the same source
 * fascicle/ui and the ACP mapper read. This half of a task does no I/O and
 * holds no SDK value, so a flow author can wrap `to_task_events` in their
 * own `to_events` and add to what it returns, as long as every event still
 * reaches it: a `step_replayed` mutes the step it names, and the step speaks
 * again once its span ends, or sooner, once the drive has passed every gate
 * the event names. From there on the step is doing new work. An `a2a_step`
 * is the case that needs it: its span stays open across the remote
 * question, and the text that follows the answer is the remote agent's
 * next round, which no client has read.
 *
 * Text goes into one artifact for each drive, in chunks. A2A marks the last
 * chunk of an artifact, and no chunk knows it's the last, so the mapper
 * holds the newest one back until the next arrives. `end_task_events` sends
 * the one it still holds once the drive has come to rest, with the output's
 * parts behind it when the drive has some.
 *
 * Reasoning and tool calls map to nothing, because A2A has no thought
 * channel and no tool card, and neither do spans, `cost`, or `emit` events.
 */

import { randomUUID } from 'node:crypto'
import type { Part } from '@a2a-js/sdk'
import type { AgentExecutionEvent } from '@a2a-js/sdk/server'
import type { TrajectoryEvent } from '#core'
import { is_record } from '#schema'
import { text_part } from './parts.js'
import type { A2aMapperOptions, A2aMapperState } from './types.js'

/**
 * Create the state for one drive's events, routing every model call's text
 * to the drive's artifact unless `stream` says otherwise.
 */
export function create_a2a_mapper_state(options: A2aMapperOptions): A2aMapperState {
  return {
    task_id: options.task_id,
    context_id: options.context_id,
    artifact_id: options.artifact_id ?? randomUUID(),
    stream: options.stream ?? (() => 'artifact'),
    replaying: new Map(),
    pending: undefined,
    sent: 0,
  }
}

/**
 * One chunk of the drive's artifact. Every chunk after the first appends.
 */
function artifact_update(state: A2aMapperState, parts: Part[], last: boolean): AgentExecutionEvent {
  const append = state.sent > 0
  state.sent += 1
  return {
    kind: 'artifactUpdate',
    data: {
      taskId: state.task_id,
      contextId: state.context_id,
      artifact: {
        artifactId: state.artifact_id,
        name: '',
        description: '',
        parts,
        metadata: undefined,
        extensions: [],
      },
      append,
      lastChunk: last,
      metadata: undefined,
    },
  }
}

/**
 * The text of a `model_chunk` event's text chunk, or `undefined` for a chunk
 * of any other kind.
 */
function chunk_text(chunk: unknown): string | undefined {
  if (!is_record(chunk) || chunk['kind'] !== 'text') return undefined
  const text = chunk['text']
  return typeof text === 'string' ? text : undefined
}

/**
 * Hold `text` back as the newest chunk, and send the one held before it.
 */
function hold(state: A2aMapperState, text: string): AgentExecutionEvent[] {
  const before = state.pending
  state.pending = text
  return before === undefined ? [] : [artifact_update(state, [text_part(before)], false)]
}

/**
 * Whether a step is running again in a span that hasn't ended.
 */
function is_replaying(state: A2aMapperState, step_id: string): boolean {
  for (const replayed of state.replaying.values()) {
    if (replayed.step_id === step_id) return true
  }
  return false
}

/**
 * The gates a `step_replayed` event says are still ahead of the drive.
 */
function gates_of(event: TrajectoryEvent): Set<string> {
  const ids: unknown = event['suspend_ids']
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
}

/**
 * Note that the drive has passed `gate`, and let every step speak that was
 * waiting on no other. A replay that named no gate waits for its span.
 */
function pass_gate(state: A2aMapperState, gate: string): void {
  for (const [span_id, replayed] of state.replaying) {
    if (replayed.gates.delete(gate) && replayed.gates.size === 0) state.replaying.delete(span_id)
  }
}

/**
 * Mute the step a `step_replayed` event names, for as long as its span runs
 * or until the drive has passed the gates the event names.
 */
function start_replay(event: TrajectoryEvent, state: A2aMapperState): void {
  const span_id = event.span_id
  const step_id = event['step_id']
  if (typeof span_id !== 'string' || typeof step_id !== 'string') return
  state.replaying.set(span_id, { step_id, gates: gates_of(event) })
}

/**
 * Take in the end of a span: a replay that ran in it is over, and a gate
 * that it was has been passed. A gate's span ends without an error only
 * when the gate took its answer.
 */
function end_span(event: TrajectoryEvent, state: A2aMapperState): void {
  if (typeof event.span_id === 'string') state.replaying.delete(event.span_id)
  const ended = event['id']
  if (typeof ended === 'string' && event['error'] === undefined) pass_gate(state, ended)
}

/**
 * Map one run event to zero or more task events. Only a `model_chunk` that
 * carries text produces any, and it produces the chunk before it. The
 * function does no I/O.
 */
export function to_task_events(event: TrajectoryEvent, state: A2aMapperState): AgentExecutionEvent[] {
  if (event.kind === 'step_replayed') start_replay(event, state)
  if (event.kind === 'span_end') end_span(event, state)
  const step_id = event['step_id']
  if (event.kind !== 'model_chunk' || typeof step_id !== 'string') return []
  const text = chunk_text(event['chunk'])
  if (text === undefined || text === '') return []
  if (is_replaying(state, step_id) || state.stream(step_id) !== 'artifact') return []
  return hold(state, text)
}

/**
 * Close the drive's artifact once the drive has come to rest: the chunk the
 * mapper still holds goes out as the last one, with `parts` behind it. A
 * drive that streamed no text sends `parts` as its whole artifact, and one
 * with neither sends nothing.
 */
export function end_task_events(state: A2aMapperState, parts: ReadonlyArray<Part> = []): AgentExecutionEvent[] {
  const held = state.pending === undefined ? [] : [text_part(state.pending)]
  state.pending = undefined
  const closing = [...held, ...parts]
  return closing.length === 0 ? [] : [artifact_update(state, closing, true)]
}

/**
 * Whether the drive has streamed any text into its artifact.
 */
export function has_streamed(state: A2aMapperState): boolean {
  return state.pending !== undefined || state.sent > 0
}
