/**
 * Streaming chunk dispatch.
 *
 * Each transport turns its provider's events into the discriminated
 * `StreamChunk` union. The dispatcher synchronously invokes on_chunk per
 * provider event; on throw
 * or rejected promise it signals the caller to abort the in-flight request
 * (the request-abort itself is wired up in the generate orchestrator) and
 * surfaces on_chunk_error.
 *
 * Chunk ordering invariants (enforced by the orchestrator that feeds the
 * dispatcher, not here):
 *   - text and reasoning interleave within a step.
 *   - tool_call_start precedes its input_deltas and end.
 *   - tool_result follows the matching tool_call_end.
 *   - step_finish is the last STREAMED chunk of a step, but tool execution and
 *     tool_result chunks are dispatched by the tool loop after it, so a step's
 *     tool_result chunks (and, for a salvaged step, the synthetic
 *     tool_call_start/tool_call_end that precede them) follow its step_finish.
 *     A salvaged step's StepRecord also reports finish_reason 'tool_calls'
 *     while its already-dispatched step_finish carries the provider's 'stop'.
 *   - finish is the last chunk of the call.
 */

import type { StreamChunk } from './types.js'
import { on_chunk_error } from './errors.js'

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
