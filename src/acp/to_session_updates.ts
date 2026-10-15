/**
 * Maps a run's events onto ACP `session/update` payloads.
 *
 * Under `run.stream`, each `model_call` records `model_chunk` events carrying
 * the engine's `StreamChunk`, the same source fascicle/ui reads. This half of
 * a prompt turn does no I/O and holds no SDK value, so a flow author can wrap
 * `to_session_updates` in their own `to_updates` and add to what it returns,
 * as long as every event still reaches it: each `span_start` advances the
 * state's count of how many times a step has run, and a workspace tool's
 * result takes its call's preview from the session's store. Spans, `cost`,
 * and `emit` events map to nothing; an `emit` never becomes chat output
 * implicitly, because output that changes with a value's shape is a trap.
 *
 * Every tool gets a plain card here. Given the turn's session, the workspace
 * tools' cards also take the look `presentation.ts` gives them.
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'
import type { TrajectoryEvent } from '#core'
import type { StreamChunk } from '#engine'
import { closing_updates, input_fields, opening_fields } from './presentation.js'
import type { CardUpdate } from './presentation.js'
import type { AcpMapperOptions, AcpMapperState, AcpStreamRoute } from './types.js'

type ToolResultChunk = Extract<StreamChunk, { kind: 'tool_result' }>

/**
 * Create the state for one prompt turn's events, routing every model call's
 * text to the reply unless `stream` says otherwise.
 */
export function create_acp_mapper_state(options: AcpMapperOptions = {}): AcpMapperState {
  return {
    turn_id: options.turn_id ?? randomUUID(),
    stream: options.stream ?? (() => 'message'),
    runs: new Map(),
    session: options.session,
    tools: new Map(),
  }
}

/**
 * Build the session-unique ACP id for an engine tool call id.
 *
 * Raw ids repeat across model calls, turns, and runs of one model call
 * (Ollama has none on the wire, so the engine numbers them
 * `ollama_call_<step>_<n>` afresh on every generate call), and a repeated id
 * would make the client update an old card instead of opening a new one.
 */
function acp_tool_call_id(state: AcpMapperState, step_id: string, raw_id: string): string {
  return `${state.turn_id}:${step_id}:${state.runs.get(step_id) ?? 0}:${raw_id}`
}

/**
 * Count one more run of the step a `span_start` opens, by the `id` its span
 * carries. Counting starts rather than finishes covers a retry whose first
 * attempt failed before it finished.
 */
function count_run(event: TrajectoryEvent, state: AcpMapperState): void {
  const id = event['id']
  if (typeof id === 'string') state.runs.set(id, (state.runs.get(id) ?? 0) + 1)
}

/**
 * Wrap streamed text as the update its route names, or nothing for `'none'`.
 */
function text_updates(route: AcpStreamRoute, text: string): SessionUpdate[] {
  const content: ContentBlock = { type: 'text', text }
  if (route === 'message') return [{ sessionUpdate: 'agent_message_chunk', content }]
  if (route === 'thought') return [{ sessionUpdate: 'agent_thought_chunk', content }]
  return []
}

/**
 * Close a tool card: `completed` with the raw output, or `failed` with the
 * error text as the card's content, since that text is what the user needs
 * to see.
 */
function tool_result_update(tool_call_id: string, chunk: ToolResultChunk): CardUpdate {
  if (chunk.error !== undefined) {
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: tool_call_id,
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: chunk.error.message } }],
    }
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: tool_call_id,
    status: 'completed',
    rawOutput: chunk.output,
  }
}

/**
 * Map one engine `StreamChunk` from the model call `step_id` to the session
 * updates it produces.
 */
function map_chunk(chunk: StreamChunk, step_id: string, state: AcpMapperState): SessionUpdate[] {
  switch (chunk.kind) {
    case 'text':
      return text_updates(state.stream(step_id), chunk.text)
    case 'reasoning':
      return text_updates('thought', chunk.text)
    case 'tool_call_start': {
      const card = acp_tool_call_id(state, step_id, chunk.id)
      state.tools.set(card, chunk.name)
      return [
        {
          sessionUpdate: 'tool_call',
          toolCallId: card,
          title: chunk.name,
          kind: 'other',
          status: 'pending',
          ...opening_fields(state.session, chunk.name, card),
        },
      ]
    }
    case 'tool_call_end': {
      const card = acp_tool_call_id(state, step_id, chunk.id)
      return [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: card,
          status: 'in_progress',
          rawInput: chunk.input,
          ...input_fields(state.session, state.tools.get(card), chunk.input),
        },
      ]
    }
    case 'tool_result': {
      const card = acp_tool_call_id(state, step_id, chunk.id)
      return closing_updates(state.session, state.tools.get(card), card, chunk, tool_result_update(card, chunk))
    }
    default:
      // The input arrives whole at tool_call_end, so its deltas add nothing,
      // and step_finish and finish carry no content for the client.
      return []
  }
}

/**
 * Narrow the loose `chunk` field of a `model_chunk` event. model_call records
 * only real StreamChunks there, and map_chunk maps a kind it doesn't know to
 * nothing, so ruling out a missing or null value is enough.
 */
function is_stream_chunk(value: unknown): value is StreamChunk {
  return typeof value === 'object' && value !== null
}

/**
 * Map one run event to zero or more ACP session updates. Only `model_chunk`
 * events produce any. A `span_start` advances the state's run count, a
 * card's opening records its tool, and a workspace tool's result takes its
 * preview; the function does no I/O.
 */
export function to_session_updates(event: TrajectoryEvent, state: AcpMapperState): SessionUpdate[] {
  if (event.kind === 'span_start') {
    count_run(event, state)
    return []
  }
  if (event.kind !== 'model_chunk') return []
  const step_id = event['step_id']
  const chunk = event['chunk']
  if (typeof step_id !== 'string' || !is_stream_chunk(chunk)) return []
  return map_chunk(chunk, step_id, state)
}
