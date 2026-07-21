/**
 * fascicle/ui: bridge a run's event stream to the AI SDK "UI message stream".
 *
 * `run.stream(flow, input)` yields `TrajectoryEvent`s; under streaming,
 * `model_call` records `model_chunk` events carrying an engine `StreamChunk`.
 * This module maps those chunks onto the AI SDK `UIMessageChunk` protocol so a
 * fascicle flow can back a `useChat` endpoint rendered by AI Elements /
 * Streamdown, with zero bespoke glue.
 *
 * It is the outbound inverse of the engine's inbound provider->StreamChunk
 * mapping. The wire framing (SSE, `data:` lines, terminal `[DONE]`, the
 * `x-vercel-ai-ui-message-stream` header) is owned by the `ai` builders; this
 * file only translates chunk shapes and manages open text/reasoning blocks.
 *
 * v7's `file`/`reasoning-file` UI parts are never emitted: the engine chunk
 * vocabulary has no generated-file kind (those provider parts drop at the
 * inbound mapping), so there is nothing here to translate them from.
 */

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  pipeUIMessageStreamToResponse,
} from 'ai'
import type { UIMessageChunk } from 'ai'
import type { ServerResponse } from 'node:http'
import type { TrajectoryEvent } from '#core'
import type { StreamChunk } from '#engine'

/**
 * The structural shape of a `run.stream(...)` handle. Typed structurally rather
 * than importing the core `StreamingRunHandle` so this module depends on no
 * core value and a caller can pass `run.stream(...)` directly.
 */
export type RunStreamLike = {
  readonly events: AsyncIterable<TrajectoryEvent>
  readonly result: Promise<unknown>
}

export type ToUiStreamOptions = {
  /** Map a thrown run error to the text of an `error` part. */
  readonly on_error?: (error: unknown) => string
}

/**
 * Per-stream state: which text/reasoning blocks are open (so `*-start` fires
 * once and `*-end` closes them) and the tool name for each in-flight call (so
 * `tool-input-available` can echo it after only the id arrives at close).
 */
export type UiMapperState = {
  readonly open_text: Set<number>
  readonly open_reasoning: Set<number>
  readonly tool_names: Map<string, string>
}

/**
 * Create an empty `UiMapperState` for a new stream.
 */
export function create_ui_mapper_state(): UiMapperState {
  return { open_text: new Set(), open_reasoning: new Set(), tool_names: new Map() }
}

/**
 * Build the UI message chunk id for a step's text block.
 */
function text_id(step_index: number): string {
  return `text-${step_index}`
}

/**
 * Build the UI message chunk id for a step's reasoning block.
 */
function reasoning_id(step_index: number): string {
  return `reasoning-${step_index}`
}

/**
 * Close the text/reasoning blocks open for one step, returning the
 * `*-end` chunks needed and updating `state` in place.
 *
 * Called on a `step_finish` chunk, so only that step's blocks close; blocks
 * open for other steps are untouched.
 */
function close_step_blocks(step_index: number, state: UiMapperState): UIMessageChunk[] {
  const parts: UIMessageChunk[] = []
  if (state.open_text.delete(step_index)) {
    parts.push({ type: 'text-end', id: text_id(step_index) })
  }
  if (state.open_reasoning.delete(step_index)) {
    parts.push({ type: 'reasoning-end', id: reasoning_id(step_index) })
  }
  return parts
}

/**
 * Close every text/reasoning block still open in `state`, returning the
 * `*-end` chunks needed.
 *
 * Used on stream `finish` and to flush any blocks still open when the
 * underlying event iterable ends.
 */
export function close_open_blocks(state: UiMapperState): UIMessageChunk[] {
  const parts: UIMessageChunk[] = []
  for (const step_index of state.open_text) {
    parts.push({ type: 'text-end', id: text_id(step_index) })
  }
  for (const step_index of state.open_reasoning) {
    parts.push({ type: 'reasoning-end', id: reasoning_id(step_index) })
  }
  state.open_text.clear()
  state.open_reasoning.clear()
  return parts
}

/**
 * Map a single engine `StreamChunk` to the `UIMessageChunk`s it produces,
 * opening and closing text/reasoning blocks in `state` as needed.
 */
function map_chunk(chunk: StreamChunk, state: UiMapperState): UIMessageChunk[] {
  switch (chunk.kind) {
    case 'text': {
      const id = text_id(chunk.step_index)
      const parts: UIMessageChunk[] = []
      if (!state.open_text.has(chunk.step_index)) {
        state.open_text.add(chunk.step_index)
        parts.push({ type: 'text-start', id })
      }
      parts.push({ type: 'text-delta', id, delta: chunk.text })
      return parts
    }
    case 'reasoning': {
      const id = reasoning_id(chunk.step_index)
      const parts: UIMessageChunk[] = []
      if (!state.open_reasoning.has(chunk.step_index)) {
        state.open_reasoning.add(chunk.step_index)
        parts.push({ type: 'reasoning-start', id })
      }
      parts.push({ type: 'reasoning-delta', id, delta: chunk.text })
      return parts
    }
    case 'tool_call_start': {
      state.tool_names.set(chunk.id, chunk.name)
      return [{ type: 'tool-input-start', toolCallId: chunk.id, toolName: chunk.name }]
    }
    case 'tool_call_input_delta':
      return [{ type: 'tool-input-delta', toolCallId: chunk.id, inputTextDelta: chunk.delta }]
    case 'tool_call_end':
      return [
        {
          type: 'tool-input-available',
          toolCallId: chunk.id,
          toolName: state.tool_names.get(chunk.id) ?? '',
          input: chunk.input,
        },
      ]
    case 'tool_result':
      return chunk.error !== undefined
        ? [{ type: 'tool-output-error', toolCallId: chunk.id, errorText: chunk.error.message }]
        : [{ type: 'tool-output-available', toolCallId: chunk.id, output: chunk.output }]
    case 'step_finish':
      return close_step_blocks(chunk.step_index, state)
    case 'finish':
      return close_open_blocks(state)
    default:
      return []
  }
}

/**
 * Narrow an untyped `TrajectoryEvent['chunk']` payload to a `StreamChunk`
 * when it looks like one (an object with a string `kind`), otherwise
 * return `undefined`.
 */
function as_stream_chunk(value: unknown): StreamChunk | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const kind = Reflect.get(value, 'kind')
  if (typeof kind !== 'string') return undefined
  // The value rode a loose TrajectoryEvent bag; model_call only records real
  // StreamChunks under `chunk`, and map_chunk narrows on `kind`, so treating it
  // as a StreamChunk is sound. Unknown kinds fall through to `[]`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as StreamChunk
}

/**
 * Map one run event to zero or more UI message chunks, advancing `state`.
 * Non-`model_chunk` events (spans, cost, user emits) yield nothing.
 */
export function to_ui_message_chunks(
  event: TrajectoryEvent,
  state: UiMapperState,
): UIMessageChunk[] {
  if (event.kind !== 'model_chunk') return []
  const chunk = as_stream_chunk(event['chunk'])
  return chunk === undefined ? [] : map_chunk(chunk, state)
}

/**
 * Build the `ReadableStream<UIMessageChunk>` that drives a `run.stream(...)`
 * handle through `to_ui_message_chunks`, used by both the `Response` and
 * Node `ServerResponse` entry points below.
 */
function build_stream(
  handle: RunStreamLike,
  options: ToUiStreamOptions,
): ReadableStream<UIMessageChunk> {
  const on_error = options.on_error
  return createUIMessageStream({
    execute: async ({ writer }) => {
      const state = create_ui_mapper_state()
      for await (const event of handle.events) {
        for (const part of to_ui_message_chunks(event, state)) writer.write(part)
      }
      for (const part of close_open_blocks(state)) writer.write(part)
      await handle.result
    },
    ...(on_error !== undefined ? { onError: on_error } : {}),
  })
}

/**
 * Turn a `run.stream(...)` handle into an SSE `Response` a `useChat` endpoint
 * can return directly.
 */
export function to_ui_message_response(
  handle: RunStreamLike,
  options: ToUiStreamOptions = {},
): Response {
  return createUIMessageStreamResponse({ stream: build_stream(handle, options) })
}

/**
 * Pipe a `run.stream(...)` handle to a Node `http.ServerResponse` as SSE, for
 * `node:http` servers that hold a `ServerResponse` rather than returning a
 * web `Response`.
 */
export function pipe_ui_message_stream_to_response(
  handle: RunStreamLike,
  response: ServerResponse,
  options: ToUiStreamOptions = {},
): void {
  pipeUIMessageStreamToResponse({ response, stream: build_stream(handle, options) })
}
