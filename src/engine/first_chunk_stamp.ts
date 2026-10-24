/**
 * The first-chunk stamp of one turn attempt, which both transports keep.
 *
 * The stamp is Date.now() at the first chunk an attempt dispatched. It's what
 * makes a failure after a chunk reached a consumer a non-retryable
 * interruption, and it becomes StepTiming.first_chunk_ms. It also notes when
 * that first chunk belonged to a tool call that arrived whole: opened and
 * closed with its input in one delta or none, which is how Ollama sends a
 * call on either transport, and how an OpenAI-compatible server does when it
 * sends the arguments in one piece. Such a call was generated before anything
 * was dispatched, so the window after the stamp isn't decode time, and
 * `throughput()` counts the step's round trip instead.
 */

import type { StreamChunk } from './types.js'

export type FirstChunkStamp = {
  /** Clears the stamp as an attempt starts. */
  readonly reset: () => void
  /** Reads one chunk the attempt dispatched, in dispatch order. */
  readonly observe: (chunk: StreamChunk) => void
  /** Date.now() at the attempt's first chunk, or undefined before one. */
  readonly at: () => number | undefined
  /** Whether the attempt's first chunk belonged to a tool call that arrived whole. */
  readonly whole_tool_call: () => boolean
}

/**
 * Creates the stamp one turn's attempts share, cleared by `reset` as each
 * attempt starts, so a failed attempt's chunks never count for the one that
 * returns.
 */
export function create_first_chunk_stamp(): FirstChunkStamp {
  let at: number | undefined
  // The tool call the first chunk opened, if it opened one. A chunk of any
  // other call fails the id match below, and every chunk does when it's
  // undefined, so nothing else needs to guard the count.
  let open_call: string | undefined
  let deltas = 0
  let whole = false

  const observe_first = (chunk: StreamChunk): void => {
    at = Date.now()
    // A lone end is a call that came with no start or delta at all, which is
    // how the AI SDK reports an Ollama tool call.
    if (chunk.kind === 'tool_call_end') whole = true
    if (chunk.kind === 'tool_call_start') open_call = chunk.id
  }

  return {
    reset: () => {
      at = undefined
      open_call = undefined
      deltas = 0
      whole = false
    },
    observe: (chunk) => {
      if (at === undefined) {
        observe_first(chunk)
        return
      }
      if (chunk.kind === 'tool_call_input_delta' && chunk.id === open_call) deltas += 1
      if (chunk.kind === 'tool_call_end' && chunk.id === open_call) whole = deltas <= 1
    },
    at: () => at,
    whole_tool_call: () => whole,
  }
}
