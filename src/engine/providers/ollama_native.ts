/**
 * Ollama native adapter (depth-1 raw HTTP) on the daemon's own /api/chat.
 *
 * Deliberately NOT the OpenAI-compatible core (D2): the compat tail is already
 * served by pointing the `openai` provider's base_url at Ollama's /v1, while
 * this endpoint exposes what compat hides — `options` (num_predict,
 * temperature, top_p and every other runtime knob), `keep_alive`, and `think`,
 * all reachable raw through `provider_options.ollama` (D9). The wire is its
 * own dialect too: newline-delimited JSON frames rather than SSE, tool-call
 * `arguments` as objects rather than JSON strings, no tool-call ids (the
 * adapter synthesizes deterministic ones), and tool results keyed by
 * `tool_name` rather than a call id.
 *
 * Zero `ai` / `@ai-sdk/*` in the module graph (C3). The adapter owns
 * request/response mapping only: generate.ts wraps invoke_turn in retry +
 * classification + abort, so failures are thrown in the shapes the shared
 * classify_provider_error already understands (`status` + `responseHeaders`
 * for HTTP transients, `kind: 'network'` for transport failures), never
 * retried here. Schema requests ride the engine's prompt + parse + repair
 * loop, so `TurnRequest.schema` is intentionally unread; effort is ignored
 * entirely (D2 — thinking is opt-in via `provider_options.ollama.think`).
 * Usage is always tolerant (D10): a local daemon that omits eval counts
 * zeroes the totals, never throws. The NDJSON aggregator rebuilds the
 * non-stream payload shape and feeds it through the same parse_ollama_chat,
 * so streamed and non-streamed results are equal by construction (C4).
 */

import type {
  AssistantContentPart,
  FinishReason,
  Message,
  StreamChunk,
  TurnRequest,
  TurnResult,
  UsageTotals,
  UserContentPart,
} from '../types.js'
import {
  engine_config_error,
  provider_auth_error,
  provider_capability_error,
  provider_error,
} from '../errors.js'
import { to_chat_tools } from './openai_compatible_native.js'
import type { NativeProviderAdapter, ProviderCapability } from './types.js'
import type { ProviderInit } from '../types.js'

type OllamaToolCall = {
  function: { name: string; arguments: unknown }
}

export type OllamaChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: OllamaToolCall[] }
  | { role: 'tool'; content: string; tool_name: string }

function to_user_content(content: string | UserContentPart[]): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const part of content) {
    if (part.type === 'image') {
      throw new provider_capability_error(
        'ollama',
        'image_input',
        "image parts are not mapped on the native transport; use transport: 'ai_sdk'",
      )
    }
    if (part.text.trim().length > 0) parts.push(part.text)
  }
  // Message content is a plain string on this wire (no part array), so
  // multi-part user content flattens with newlines between parts.
  return parts.join('\n')
}

function to_assistant_message(content: string | AssistantContentPart[]): OllamaChatMessage {
  if (typeof content === 'string') return { role: 'assistant', content }
  const text_parts: string[] = []
  const tool_calls: OllamaToolCall[] = []
  for (const part of content) {
    if (part.type === 'text') {
      text_parts.push(part.text)
    } else {
      // arguments is a structured object on this wire, not a JSON string, and
      // the API has no id field on tool calls, so the part's id is dropped
      // here and re-synthesized deterministically when a response is parsed.
      tool_calls.push({ function: { name: part.name, arguments: part.input } })
    }
  }
  const message: OllamaChatMessage = { role: 'assistant', content: text_parts.join('') }
  if (tool_calls.length > 0) message.tool_calls = tool_calls
  return message
}

/**
 * Map fascicle Message[] to the /api/chat shape. System messages map in place
 * (no top-level system field); tool results are `tool` role messages keyed by
 * `tool_name`, since this wire has no tool_call_id to round-trip.
 */
export function to_ollama_messages(messages: ReadonlyArray<Message>): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: message.content })
        break
      case 'user':
        out.push({ role: 'user', content: to_user_content(message.content) })
        break
      case 'assistant':
        out.push(to_assistant_message(message.content))
        break
      case 'tool':
        out.push({ role: 'tool', tool_name: message.name, content: message.content })
        break
    }
  }
  return out
}

export function build_ollama_chat_body(req: TurnRequest): Record<string, unknown> {
  const messages: OllamaChatMessage[] = []
  if (req.system !== undefined && req.system.length > 0) {
    messages.push({ role: 'system', content: req.system })
  }
  messages.push(...to_ollama_messages(req.messages))

  const body: Record<string, unknown> = {
    model: req.model_id,
    messages,
    // /api/chat streams by default, so the flag is always explicit — a
    // non-stream call that omits it would get NDJSON back.
    stream: req.stream,
  }
  // Tool definitions use the OpenAI function shape verbatim on this endpoint.
  if (req.tools.length > 0) body['tools'] = to_chat_tools(req.tools)
  // Sampling params live under the runtime's `options` bag, not at the top
  // level. Effort is intentionally unread (D2): there is no reasoning_effort
  // on this wire, and `think` is opt-in via provider_options.ollama.
  const options: Record<string, unknown> = {}
  if (req.max_tokens !== undefined) options['num_predict'] = req.max_tokens
  if (req.temperature !== undefined) options['temperature'] = req.temperature
  if (req.top_p !== undefined) options['top_p'] = req.top_p
  if (Object.keys(options).length > 0) body['options'] = options
  // provider_options.ollama is raw wire-format passthrough (think, keep_alive,
  // format, options, ...), shallow-merged last so an explicit user key beats
  // every derived field (D9). Shallow means a passthrough `options` object
  // replaces the engine-derived one wholesale rather than merging into it.
  const passthrough = req.provider_options?.['ollama']
  return passthrough === undefined ? body : { ...body, ...passthrough }
}

/**
 * Appendix A2, Ollama row: the presence of tool calls wins (the wire reports
 * done_reason 'stop' on a tool-call turn), then `length`; everything else —
 * 'stop', 'load', absent — means the model stopped on its own.
 */
export function map_ollama_finish_reason(raw: unknown, has_tool_calls: boolean): FinishReason {
  if (has_tool_calls) return 'tool_calls'
  return raw === 'length' ? 'length' : 'stop'
}

/**
 * Appendix A3, Ollama row: prompt_eval_count → input_tokens, eval_count →
 * output_tokens; no cache or reasoning fields exist on this wire. Counts are
 * always tolerant (D10): a local daemon that omits them (or a mid-stream
 * frame, which never carries them) zeroes the totals, never throws.
 */
export function map_ollama_usage(payload: unknown): UsageTotals {
  if (payload === null || typeof payload !== 'object') {
    return { input_tokens: 0, output_tokens: 0 }
  }
  const prompt: unknown = Reflect.get(payload, 'prompt_eval_count')
  const evaluated: unknown = Reflect.get(payload, 'eval_count')
  return {
    input_tokens: typeof prompt === 'number' ? prompt : 0,
    output_tokens: typeof evaluated === 'number' ? evaluated : 0,
  }
}

/**
 * This wire sends no tool-call id, so one is synthesized from the step index
 * and the call's ordinal within the turn — deterministic, so the streamed and
 * non-streamed parses of the same turn agree (C4), and unique across steps so
 * transcript tool results stay unambiguous. A wire id is preferred if a
 * future daemon version starts sending one.
 */
function parse_ollama_tool_call(
  raw: unknown,
  ordinal: number,
  step_index: number,
): TurnResult['tool_calls'][number] {
  if (raw === null || typeof raw !== 'object') {
    throw new provider_error('ollama native: malformed tool_calls entry in response')
  }
  const fn: unknown = Reflect.get(raw, 'function')
  if (fn === null || typeof fn !== 'object') {
    throw new provider_error('ollama native: malformed tool_calls entry in response')
  }
  const name: unknown = Reflect.get(fn, 'name')
  if (typeof name !== 'string') {
    throw new provider_error('ollama native: malformed tool_calls entry in response')
  }
  const wire_id: unknown = Reflect.get(raw, 'id')
  const id = typeof wire_id === 'string' && wire_id.length > 0
    ? wire_id
    : `ollama_call_${step_index}_${ordinal}`
  // arguments is a structured object on this wire; a string is tolerated as
  // JSON for compat-shaped proxies ('' meaning '{}', like the OpenAI wire).
  const raw_args: unknown = Reflect.get(fn, 'arguments')
  let input: unknown = {}
  if (typeof raw_args === 'string' && raw_args.length > 0) {
    try {
      input = JSON.parse(raw_args)
    } catch {
      throw new provider_error(
        `ollama native: tool_calls arguments for ${name} is not valid JSON`,
      )
    }
  } else if (raw_args !== null && typeof raw_args === 'object') {
    input = raw_args
  }
  return { id, name, input }
}

/**
 * The one response parser every path feeds (C4): non-stream parses the
 * payload directly, and the NDJSON aggregator rebuilds this same payload
 * shape from its frames before calling it.
 */
export function parse_ollama_chat(payload: unknown, step_index: number): TurnResult {
  if (payload === null || typeof payload !== 'object') {
    throw new provider_error('ollama native: response payload is not a JSON object')
  }
  const message: unknown = Reflect.get(payload, 'message')
  if (message === null || message === undefined || typeof message !== 'object') {
    throw new provider_error('ollama native: response has no message')
  }
  const content: unknown = Reflect.get(message, 'content')
  const raw_tool_calls: unknown = Reflect.get(message, 'tool_calls')
  const tool_calls = Array.isArray(raw_tool_calls)
    ? raw_tool_calls.map((entry, ordinal) => parse_ollama_tool_call(entry, ordinal, step_index))
    : []
  return {
    text: typeof content === 'string' ? content : '',
    tool_calls,
    finish_reason: map_ollama_finish_reason(
      Reflect.get(payload, 'done_reason'),
      tool_calls.length > 0,
    ),
    usage: map_ollama_usage(payload),
  }
}

/**
 * Incremental NDJSON framing: push() takes decoded text at any chunk boundary
 * (including mid-line) and returns the complete lines it finished; flush()
 * drains a final line left open when the stream ends without a trailing
 * newline. Blank lines are dropped; JSON parsing is the aggregator's job.
 */
function take_line(raw: string, out: string[]): void {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  if (line.trim().length > 0) out.push(line)
}

export function create_ndjson_decoder(): {
  push: (text: string) => string[]
  flush: () => string[]
} {
  let buffer = ''

  return {
    push(text: string): string[] {
      buffer += text
      const out: string[] = []
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        take_line(buffer.slice(0, newline), out)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      return out
    },
    flush(): string[] {
      const out: string[] = []
      if (buffer.length > 0) take_line(buffer, out)
      buffer = ''
      return out
    },
  }
}

/**
 * Consume /api/chat NDJSON frames, dispatching StreamChunks as they arrive
 * and rebuilding the non-stream payload as it goes: `message.content`
 * accumulates into the turn text, and `message.tool_calls` entries arrive
 * WHOLE per frame — arguments are complete objects on this wire, so each call
 * dispatches tool_call_start then tool_call_end with no input deltas between.
 * The `done: true` frame carries done_reason and the eval counts and closes
 * the turn (step_finish); frames after it are ignored. A stream that ends
 * without one is truncated output, so complete() fails loud instead of
 * returning a partial turn. complete() feeds the synthetic payload through
 * parse_ollama_chat, which is what makes the streamed TurnResult equal the
 * non-streamed one by construction (C4).
 */
export function create_ollama_stream_aggregator(
  step_index: number,
  dispatch: (chunk: StreamChunk) => Promise<void>,
): {
  handle_line: (line: string) => Promise<void>
  complete: () => TurnResult
} {
  let text = ''
  const tool_calls: Array<TurnResult['tool_calls'][number]> = []
  let done = false
  let done_reason: unknown
  let usage: UsageTotals = { input_tokens: 0, output_tokens: 0 }

  const on_message = async (message: object): Promise<void> => {
    const content: unknown = Reflect.get(message, 'content')
    if (typeof content === 'string' && content.length > 0) {
      text += content
      await dispatch({ kind: 'text', text: content, step_index })
    }
    const raw_calls: unknown = Reflect.get(message, 'tool_calls')
    if (!Array.isArray(raw_calls)) return
    for (const entry of raw_calls) {
      const call = parse_ollama_tool_call(entry, tool_calls.length, step_index)
      tool_calls.push(call)
      // oxlint-disable-next-line no-await-in-loop
      await dispatch({ kind: 'tool_call_start', id: call.id, name: call.name, step_index })
      // oxlint-disable-next-line no-await-in-loop
      await dispatch({ kind: 'tool_call_end', id: call.id, input: call.input, step_index })
    }
  }

  return {
    async handle_line(line: string): Promise<void> {
      if (done) return
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        throw new provider_error('ollama native: stream frame is not valid JSON')
      }
      if (frame === null || typeof frame !== 'object') return
      const message: unknown = Reflect.get(frame, 'message')
      if (message !== null && message !== undefined && typeof message === 'object') {
        await on_message(message)
      }
      if (Reflect.get(frame, 'done') === true) {
        done = true
        done_reason = Reflect.get(frame, 'done_reason')
        usage = map_ollama_usage(frame)
        await dispatch({
          kind: 'step_finish',
          step_index,
          finish_reason: map_ollama_finish_reason(done_reason, tool_calls.length > 0),
          usage,
        })
      }
    },
    complete(): TurnResult {
      if (!done) {
        throw new provider_error(
          'ollama native: stream ended before its done frame; the result would be truncated',
        )
      }
      const message: Record<string, unknown> = { role: 'assistant', content: text }
      if (tool_calls.length > 0) {
        // Rebuilt entries carry the synthesized ids, which the parser prefers
        // over re-synthesizing, so streamed ids match the dispatched chunks.
        message['tool_calls'] = tool_calls.map((call) => ({
          id: call.id,
          function: { name: call.name, arguments: call.input },
        }))
      }
      return parse_ollama_chat(
        {
          message,
          done: true,
          done_reason: done_reason ?? null,
          prompt_eval_count: usage.input_tokens,
          eval_count: usage.output_tokens,
        },
        step_index,
      )
    },
  }
}

/** Ollama error bodies are `{ error: "message" }`; tolerate the nested OpenAI shape too. */
function extract_error_message(body: string): string {
  if (body.length === 0) return '(empty body)'
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object') {
      const error: unknown = Reflect.get(parsed, 'error')
      if (typeof error === 'string' && error.length > 0) return error
      if (error !== null && typeof error === 'object') {
        const message: unknown = Reflect.get(error, 'message')
        if (typeof message === 'string' && message.length > 0) return message
      }
    }
  } catch {
    // Not JSON; fall through to the raw snippet.
  }
  return body.length > 300 ? `${body.slice(0, 300)}...` : body
}

/**
 * Map a non-2xx response to what the engine's retry stack expects: 401
 * becomes a typed provider_auth_error (rare locally, but base_url may point
 * at a fronted daemon), 429/5xx keep `status` + `responseHeaders` so
 * classify_provider_error marks them retryable, and any other 4xx (a missing
 * model, a malformed request) is a permanent provider_error.
 */
async function response_error(response: Response): Promise<Error> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    // Body is best-effort detail; classification needs only the status.
  }
  const detail = extract_error_message(body)
  const status = response.status
  if (status === 401) {
    return new provider_auth_error('ollama', `ollama authentication failed (401): ${detail}`)
  }
  if (status === 429 || status >= 500) {
    const retry_after = response.headers.get('retry-after')
    return Object.assign(
      new Error(`ollama API error ${status}: ${detail}`),
      { status },
      retry_after !== null ? { responseHeaders: { 'retry-after': retry_after } } : {},
    )
  }
  return new provider_error(`ollama API error ${status}: ${detail}`, { status, body })
}

/**
 * A user abort surfaces as the fetch AbortError; retry_turn converts it via
 * its own signal check, so it is rethrown untouched. Everything else is a
 * transport failure wrapped in the `kind: 'network'` shape the shared
 * classify_provider_error marks retryable.
 */
function rethrow_network_failure(err: unknown, abort: AbortSignal): never {
  if (abort.aborted) throw err
  const detail = err instanceof Error ? err.message : String(err)
  throw Object.assign(new Error(`ollama native: network failure: ${detail}`), {
    kind: 'network',
  })
}

/**
 * Drain a streaming /api/chat response: decode bytes, reassemble NDJSON
 * lines, and feed each to the aggregator, which dispatches chunks through
 * req.dispatch_chunk as they arrive. Transport failures mid-read wrap as
 * network errors; aggregator throws (malformed frames, a rejecting on_chunk)
 * pass through untouched, with the reader cancelled so the connection is
 * released.
 */
async function consume_ndjson_response(response: Response, req: TurnRequest): Promise<TurnResult> {
  const body = response.body
  if (body === null) {
    throw new provider_error('ollama native: streaming response has no body')
  }
  const dispatch = req.dispatch_chunk ?? (async (): Promise<void> => {})
  const aggregator = create_ollama_stream_aggregator(req.step_index, dispatch)
  const reader = body.getReader()
  const text_decoder = new TextDecoder()
  const ndjson = create_ndjson_decoder()

  const next_bytes = async (): Promise<Uint8Array | undefined> => {
    let step: Awaited<ReturnType<typeof reader.read>>
    try {
      step = await reader.read()
    } catch (err: unknown) {
      rethrow_network_failure(err, req.abort)
    }
    return step.done ? undefined : step.value
  }

  // Sequential awaits are the contract here: chunk order is an engine
  // invariant and each frame mutates aggregator state, so no parallelism.
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop
      const bytes = await next_bytes()
      if (bytes === undefined) break
      for (const line of ndjson.push(text_decoder.decode(bytes, { stream: true }))) {
        // oxlint-disable-next-line no-await-in-loop
        await aggregator.handle_line(line)
      }
    }
  } finally {
    // Frees the connection when an error exits the loop early; a no-op on a
    // fully drained stream.
    void reader.cancel().catch(() => {})
  }
  const tail = [...ndjson.push(text_decoder.decode()), ...ndjson.flush()]
  for (const line of tail) {
    // oxlint-disable-next-line no-await-in-loop
    await aggregator.handle_line(line)
  }
  return aggregator.complete()
}

// 'structured_output' is intentionally absent (schema rides the prompt +
// parse + repair loop, parity with native Anthropic; the daemon's `format`
// field stays reachable via provider_options.ollama.format); 'reasoning' is
// absent because effort is ignored on this wire (D2); image parts are
// unmapped on this transport.
const SUPPORTED: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
])

export const create_ollama_native_adapter = (init: ProviderInit): NativeProviderAdapter => {
  const raw_base_url = typeof init.base_url === 'string' ? init.base_url : ''
  if (raw_base_url.length === 0) {
    throw new engine_config_error('ollama provider requires a non-empty base_url', 'ollama')
  }
  // base_url is the daemon root (http://localhost:11434), the same value the
  // ai_sdk transport takes, so flipping transports never means re-pointing it.
  const base_url = raw_base_url.replace(/\/+$/, '')

  return {
    kind: 'native',
    name: 'ollama',
    async invoke_turn(req: TurnRequest): Promise<TurnResult> {
      let response: Response
      try {
        response = await fetch(`${base_url}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(build_ollama_chat_body(req)),
          signal: req.abort,
        })
      } catch (err: unknown) {
        rethrow_network_failure(err, req.abort)
      }
      if (!response.ok) throw await response_error(response)
      if (req.stream) return consume_ndjson_response(response, req)
      const payload: unknown = await response.json()
      return parse_ollama_chat(payload, req.step_index)
    },
    supports: (capability) => SUPPORTED.has(capability),
  }
}
