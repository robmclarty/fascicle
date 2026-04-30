/**
 * Streaming chunk normalization and dispatch.
 *
 * Provider events are normalized into the discriminated StreamChunk union from
 * spec §5.6. The dispatcher synchronously invokes on_chunk per provider event;
 * on throw or rejected promise it signals the caller to abort the in-flight
 * request (the actual request-abort is wired in phase 2's generate
 * orchestrator) and surfaces on_chunk_error.
 *
 * Chunk ordering invariants (enforced by the orchestrator that feeds the
 * dispatcher, not here):
 *   - text and reasoning interleave within a step.
 *   - tool_call_start precedes its input_deltas and end.
 *   - tool_result follows the matching tool_call_end.
 *   - step_finish is the last chunk of a step.
 *   - finish is the last chunk of the call.
 */

import type { FinishReason, StreamChunk, UsageTotals } from './types.js'
import { on_chunk_error } from './errors.js'

export type RawProviderStreamEvent =
  | { type: 'text-delta'; id?: string; delta: string }
  | { type: 'reasoning-delta'; id?: string; delta: string }
  | { type: 'tool-input-start'; id: string; tool_name: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string; input: unknown }
  | { type: 'tool-result'; id: string; output?: unknown; error?: { message: string } }
  | { type: 'finish-step'; finish_reason: FinishReason; usage: UsageTotals }
  | { type: 'finish'; finish_reason: FinishReason; usage: UsageTotals }

/**
 * Normalize a single AI SDK v6 stream event into a StreamChunk with the
 * supplied step_index. Unknown event types return undefined (caller drops).
 */
export function normalize_chunk(
  event: RawProviderStreamEvent,
  step_index: number,
): StreamChunk | undefined {
  switch (event.type) {
    case 'text-delta':
      return { kind: 'text', text: event.delta, step_index }
    case 'reasoning-delta':
      return { kind: 'reasoning', text: event.delta, step_index }
    case 'tool-input-start':
      return { kind: 'tool_call_start', id: event.id, name: event.tool_name, step_index }
    case 'tool-input-delta':
      return { kind: 'tool_call_input_delta', id: event.id, delta: event.delta, step_index }
    case 'tool-input-end':
      return { kind: 'tool_call_end', id: event.id, input: event.input, step_index }
    case 'tool-result': {
      const chunk: StreamChunk = { kind: 'tool_result', id: event.id, step_index }
      if (event.output !== undefined) chunk.output = event.output
      if (event.error !== undefined) chunk.error = event.error
      return chunk
    }
    case 'finish-step':
      return {
        kind: 'step_finish',
        step_index,
        finish_reason: event.finish_reason,
        usage: event.usage,
      }
    case 'finish':
      return { kind: 'finish', finish_reason: event.finish_reason, usage: event.usage }
    default:
      return undefined
  }
}

export type ChunkDispatcher = {
  readonly dispatch: (chunk: StreamChunk) => Promise<void>
  readonly aborted: () => boolean
}

/**
 * Build a dispatcher around a user-supplied on_chunk. Catches sync throws and
 * rejected promises; once an error is recorded subsequent dispatch calls are
 * no-ops and `aborted()` returns true so the orchestrator can short-circuit
 * the in-flight provider request. The first error is re-thrown from the first
 * failing dispatch() call, wrapped in on_chunk_error.
 */
export function create_chunk_dispatcher(
  on_chunk: ((chunk: StreamChunk) => void | Promise<void>) | undefined,
): ChunkDispatcher {
  let failed = false
  return {
    aborted: () => failed,
    async dispatch(chunk: StreamChunk): Promise<void> {
      if (on_chunk === undefined || failed) return
      try {
        const maybe = on_chunk(chunk)
        if (maybe !== undefined && typeof maybe.then === 'function') {
          await maybe
        }
      } catch (err: unknown) {
        failed = true
        throw new on_chunk_error('on_chunk callback failed', err)
      }
    },
  }
}
