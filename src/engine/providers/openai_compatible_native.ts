/**
 * OpenAI-compatible native core: one `chat/completions` implementation
 * talking raw HTTP, shared by every OpenAI-compatible provider.
 *
 * Parameterized by a dialect config: base_url, auth strategy, extra headers,
 * stream-usage behavior, token-limit field name, and usage tolerance. The
 * `openai`, `openrouter`, and `lmstudio` factories each build a dialect and
 * share this core; pointing base_url at any compat server (including
 * Ollama's /v1) rides the same path.
 *
 * This module imports nothing from `ai` or `@ai-sdk/*`. The adapter owns
 * request/response mapping only: generate.ts wraps invoke_turn in retry +
 * classification + abort, so failures are thrown in shapes the shared
 * classify_provider_error already understands (`status` + `responseHeaders`
 * for HTTP transients, `kind: 'network'` for transport failures), never
 * retried here. Schema requests ride the engine's prompt + parse + repair
 * loop, so `TurnRequest.schema` is intentionally unread. Streaming hand-rolls
 * the SSE parse (`data:` lines, the literal `[DONE]` terminator, index-keyed
 * tool_call delta accumulation); the aggregator rebuilds the non-stream
 * payload shape and feeds it through the same parse_chat_completion, so
 * streamed and non-streamed results are equal by construction rather than by
 * parallel code paths.
 */

import { to_json_schema } from '#schema'
import type {
  AssistantContentPart,
  EffortLevel,
  FinishReason,
  Message,
  StreamChunk,
  Tool,
  TurnRequest,
  TurnResult,
  UsageTotals,
  UserContentPart,
} from '../types.js'
import {
  engine_config_error,
  provider_capability_error,
  provider_error,
} from '../errors.js'
import {
  consume_framed_stream,
  invoke_http_turn,
  map_messages_by_role,
  parse_tool_call_arguments,
  split_assistant_parts,
} from './native_shared.js'
import { create_sse_decoder } from './sse_native.js'
import type { NativeProviderAdapter, ProviderCapability } from './types.js'

/**
 * Per-dialect wire knobs. `name` is the provider name the adapter reports
 * and the `provider_options` key it reads, kept stable across transports so
 * pricing keys and usage fields carry over. `tolerant_usage` marks backends
 * whose usage may be absent or approximate (lmstudio, ollama-compat): the
 * mapper returns zeroed totals instead of throwing.
 */
export type OpenAICompatibleDialect = {
  readonly name: string
  readonly base_url: string
  readonly auth: { kind: 'bearer'; api_key: string } | { kind: 'none' }
  readonly extra_headers?: Readonly<Record<string, string>>
  readonly token_limit_field: 'max_tokens' | 'max_completion_tokens'
  readonly stream_include_usage: boolean
  readonly tolerant_usage: boolean
}

/**
 * The wire enum is `low | medium | high` only, so `xhigh` and `max` clamp to
 * `high`, the same clamp as the ai_sdk transport's `reasoningEffort`. `none`
 * omits the field entirely. Non-reasoning models ignore the field
 * server-side; the adapter does not model-sniff.
 */
const OPENAI_COMPATIBLE_REASONING_EFFORT: Record<
  Exclude<EffortLevel, 'none'>,
  'low' | 'medium' | 'high'
> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

type ChatToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<{ type: 'text'; text: string }> }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/**
 * Map user message content to this wire's shape (a string, or an array of
 * text parts). Image parts throw a capability error: they are not mapped on
 * the native transport.
 */
function to_user_content(
  content: string | UserContentPart[],
  provider: string,
): string | Array<{ type: 'text'; text: string }> {
  if (typeof content === 'string') return content
  const parts: Array<{ type: 'text'; text: string }> = []
  for (const part of content) {
    if (part.type === 'image') {
      throw new provider_capability_error(
        provider,
        'image_input',
        "image parts are not mapped on the native transport; use transport: 'ai_sdk'",
      )
    }
    if (part.text.trim().length > 0) parts.push({ type: 'text', text: part.text })
  }
  return parts.length > 0 ? parts : ''
}

/**
 * Map assistant message content to Chat Completions shape: text parts join
 * into `content`, and tool-call parts become `tool_calls` entries with
 * JSON-stringified arguments.
 */
function to_assistant_message(content: string | AssistantContentPart[]): ChatMessage {
  if (typeof content === 'string') return { role: 'assistant', content }
  const { texts, tool_parts } = split_assistant_parts(content)
  const tool_calls: ChatToolCall[] = tool_parts.map((part) => ({
    id: part.id,
    type: 'function',
    function: { name: part.name, arguments: JSON.stringify(part.input) },
  }))
  const text = texts.join('')
  // A tool-call turn with no prose sends content: null, the shape the API
  // itself produces; an all-text turn keeps its (possibly empty) string.
  const message: ChatMessage = {
    role: 'assistant',
    content: text.length > 0 || tool_calls.length === 0 ? text : null,
  }
  if (tool_calls.length > 0) message.tool_calls = tool_calls
  return message
}

/**
 * Map fascicle Message[] to Chat Completions shape. Unlike the Messages API
 * there is no top-level system field or role-alternation constraint: system
 * messages map in place at any position, and tool results are first-class
 * `tool` role messages keyed by tool_call_id.
 */
export function to_chat_messages(
  messages: ReadonlyArray<Message>,
  provider: string,
): ChatMessage[] {
  return map_messages_by_role<ChatMessage>(messages, {
    system: (content) => ({ role: 'system', content }),
    user: (content) => ({ role: 'user', content: to_user_content(content, provider) }),
    assistant: to_assistant_message,
    tool: (message) => ({
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: message.content,
    }),
  })
}

/**
 * Map fascicle Tool[] to the Chat Completions function-tool shape,
 * converting each input schema to JSON Schema.
 */
export function to_chat_tools(tools: ReadonlyArray<Tool>): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: to_json_schema(tool.input_schema),
    },
  }))
}

/**
 * Build the Chat Completions request body for one turn: mapped messages and
 * tools, the token-limit field named per dialect, sampling params, the
 * effort-derived reasoning_effort, and the dialect's
 * `provider_options.<name>` wire passthrough merged last.
 */
export function build_chat_completions_body(
  req: TurnRequest,
  dialect: OpenAICompatibleDialect,
): Record<string, unknown> {
  const messages: ChatMessage[] = []
  if (req.system !== undefined && req.system.length > 0) {
    messages.push({ role: 'system', content: req.system })
  }
  messages.push(...to_chat_messages(req.messages, dialect.name))

  const body: Record<string, unknown> = {
    model: req.model_id,
    messages,
  }
  if (req.tools.length > 0) body['tools'] = to_chat_tools(req.tools)
  if (req.max_tokens !== undefined) body[dialect.token_limit_field] = req.max_tokens
  if (req.temperature !== undefined) body['temperature'] = req.temperature
  if (req.top_p !== undefined) body['top_p'] = req.top_p
  if (req.effort !== 'none') {
    body['reasoning_effort'] = OPENAI_COMPATIBLE_REASONING_EFFORT[req.effort]
  }
  if (req.stream) {
    body['stream'] = true
    // Usage arrives on the final pre-DONE chunk only when asked for; local
    // backends that ignore the flag fall under tolerant_usage.
    if (dialect.stream_include_usage) body['stream_options'] = { include_usage: true }
  }
  // provider_options.<name> is raw wire-format passthrough (snake_case
  // chat/completions keys), shallow-merged last so an explicit user key beats
  // every derived field: the effort-derived reasoning_effort, the token
  // limit, sampling params. Wire keys are the user asserting they know the
  // wire; the adapter does not reconcile interactions the API rejects.
  const passthrough = req.provider_options?.[dialect.name]
  return passthrough === undefined ? body : { ...body, ...passthrough }
}

/**
 * Map the Chat Completions finish_reason to the engine's FinishReason.
 */
export function map_chat_finish_reason(raw: unknown): FinishReason {
  switch (raw) {
    case 'tool_calls':
      return 'tool_calls'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    // stop and anything unrecognized both mean "the model stopped on its own".
    default:
      return 'stop'
  }
}

/**
 * Read a numeric field from a usage object, or undefined if absent or not a
 * number.
 */
function read_number(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'number' ? value : undefined
}

/**
 * Map the Chat Completions usage object to UsageTotals. prompt_tokens is
 * already INCLUSIVE of cached tokens on this API, unlike Anthropic's
 * exclusive accounting, so a straight copy is correct; compute_cost
 * subtracts the cached portion back out. No cache-write concept exists on
 * this wire. A missing usage object throws under a strict dialect (a hosted
 * API omitting usage is a broken response) and zeroes under a tolerant one.
 */
export function map_chat_usage(raw: unknown, dialect: OpenAICompatibleDialect): UsageTotals {
  if (raw === null || typeof raw !== 'object') {
    if (dialect.tolerant_usage) return { input_tokens: 0, output_tokens: 0 }
    throw new provider_error(
      `${dialect.name} native: response is missing its usage object`,
    )
  }
  const totals: UsageTotals = {
    input_tokens: read_number(raw, 'prompt_tokens') ?? 0,
    output_tokens: read_number(raw, 'completion_tokens') ?? 0,
  }
  const prompt_details: unknown = Reflect.get(raw, 'prompt_tokens_details')
  if (prompt_details !== null && typeof prompt_details === 'object') {
    const cached = read_number(prompt_details, 'cached_tokens')
    if (cached !== undefined) totals.cached_input_tokens = cached
  }
  const completion_details: unknown = Reflect.get(raw, 'completion_tokens_details')
  if (completion_details !== null && typeof completion_details === 'object') {
    const reasoning = read_number(completion_details, 'reasoning_tokens')
    if (reasoning !== undefined) totals.reasoning_tokens = reasoning
  }
  return totals
}

/**
 * Parse one Chat Completions tool_calls entry into the engine's tool-call
 * shape, throwing a provider_error if the entry is missing id, function
 * name, or valid JSON arguments.
 */
function parse_tool_call(raw: unknown, provider: string): TurnResult['tool_calls'][number] {
  if (raw === null || typeof raw !== 'object') {
    throw new provider_error(`${provider} native: malformed tool_calls entry in response`)
  }
  const id: unknown = Reflect.get(raw, 'id')
  const fn: unknown = Reflect.get(raw, 'function')
  if (typeof id !== 'string' || fn === null || typeof fn !== 'object') {
    throw new provider_error(`${provider} native: malformed tool_calls entry in response`)
  }
  const name: unknown = Reflect.get(fn, 'name')
  if (typeof name !== 'string') {
    throw new provider_error(`${provider} native: malformed tool_calls entry in response`)
  }
  // arguments is a JSON string on this wire.
  const input = parse_tool_call_arguments(Reflect.get(fn, 'arguments'), provider, name)
  return { id, name, input }
}

/**
 * The one response parser every path feeds: non-stream parses the payload
 * directly, and the streaming aggregator (next step) rebuilds this same
 * payload shape from deltas before calling it.
 */
export function parse_chat_completion(
  payload: unknown,
  dialect: OpenAICompatibleDialect,
): TurnResult {
  if (payload === null || typeof payload !== 'object') {
    throw new provider_error(
      `${dialect.name} native: response payload is not a JSON object`,
    )
  }
  const choices: unknown = Reflect.get(payload, 'choices')
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined
  if (choice === null || choice === undefined || typeof choice !== 'object') {
    throw new provider_error(`${dialect.name} native: response has no choices`)
  }
  const message: unknown = Reflect.get(choice, 'message')
  if (message === null || typeof message !== 'object') {
    throw new provider_error(`${dialect.name} native: response choice has no message`)
  }
  const content: unknown = Reflect.get(message, 'content')
  const raw_tool_calls: unknown = Reflect.get(message, 'tool_calls')
  const tool_calls = Array.isArray(raw_tool_calls)
    ? raw_tool_calls.map((entry) => parse_tool_call(entry, dialect.name))
    : []
  return {
    text: typeof content === 'string' ? content : '',
    tool_calls,
    finish_reason: map_chat_finish_reason(Reflect.get(choice, 'finish_reason')),
    usage: map_chat_usage(Reflect.get(payload, 'usage'), dialect),
  }
}

/**
 * Consume Chat Completions stream frames (the JSON payload of each SSE
 * `data:` line, plus the literal `[DONE]` terminator), dispatching
 * StreamChunks as they arrive and rebuilding the non-stream payload as it
 * goes: `delta.content` accumulates into the message text, and
 * `delta.tool_calls[]` entries accumulate `function.arguments` string deltas
 * keyed by their `index` field. A tool call closes (parsed input dispatched)
 * when the choice's finish_reason frame arrives, or at `[DONE]` for servers
 * that never send one. Usage rides the final pre-DONE frame
 * (stream_options.include_usage); a stream that ends without `[DONE]` is
 * truncated output, so complete() fails loud instead of returning a partial
 * turn. complete() feeds the synthetic payload through parse_chat_completion,
 * which is what makes the streamed TurnResult equal the non-streamed one by
 * construction.
 */
export function create_chat_stream_aggregator(
  dialect: OpenAICompatibleDialect,
  step_index: number,
  dispatch: (chunk: StreamChunk) => Promise<void>,
): {
  handle_data: (data: string) => Promise<void>
  complete: () => TurnResult
} {
  type OpenToolCall = {
    index: number
    id: string
    name: string
    arguments: string
    closed: boolean
  }
  let text = ''
  const tool_calls: OpenToolCall[] = []
  const by_index = new Map<number, OpenToolCall>()
  let finish_reason: string | undefined
  let usage: unknown
  let done = false

  const in_index_order = (): OpenToolCall[] =>
    tool_calls.toSorted((a, b) => a.index - b.index)

  const close_tool_calls = async (): Promise<void> => {
    for (const call of in_index_order()) {
      if (call.closed) continue
      call.closed = true
      // parse_tool_call applies the same argument rules as the non-stream
      // path ('' means '{}', bad JSON is a provider_error naming the tool).
      const { input } = parse_tool_call(
        { id: call.id, function: { name: call.name, arguments: call.arguments } },
        dialect.name,
      )
      // oxlint-disable-next-line no-await-in-loop
      await dispatch({ kind: 'tool_call_end', id: call.id, input, step_index })
    }
  }

  const on_tool_call_delta = async (entry: unknown): Promise<void> => {
    if (entry === null || typeof entry !== 'object') {
      throw new provider_error(
        `${dialect.name} native: malformed tool_calls delta in stream`,
      )
    }
    const index: unknown = Reflect.get(entry, 'index')
    if (typeof index !== 'number') {
      throw new provider_error(
        `${dialect.name} native: stream tool_calls delta is missing its index`,
      )
    }
    const fn: unknown = Reflect.get(entry, 'function')
    let call = by_index.get(index)
    if (call === undefined) {
      const id: unknown = Reflect.get(entry, 'id')
      const name: unknown =
        fn !== null && typeof fn === 'object' ? Reflect.get(fn, 'name') : undefined
      if (typeof id !== 'string' || typeof name !== 'string') {
        throw new provider_error(
          `${dialect.name} native: stream tool_calls delta opened without id and name`,
        )
      }
      call = { index, id, name, arguments: '', closed: false }
      by_index.set(index, call)
      tool_calls.push(call)
      await dispatch({ kind: 'tool_call_start', id, name, step_index })
    }
    if (fn === null || typeof fn !== 'object') return
    const args: unknown = Reflect.get(fn, 'arguments')
    if (typeof args === 'string' && args.length > 0) {
      call.arguments += args
      await dispatch({
        kind: 'tool_call_input_delta',
        id: call.id,
        delta: args,
        step_index,
      })
    }
  }

  const on_choice = async (choice: object): Promise<void> => {
    const delta: unknown = Reflect.get(choice, 'delta')
    if (delta !== null && typeof delta === 'object') {
      const content: unknown = Reflect.get(delta, 'content')
      if (typeof content === 'string' && content.length > 0) {
        text += content
        await dispatch({ kind: 'text', text: content, step_index })
      }
      const raw_calls: unknown = Reflect.get(delta, 'tool_calls')
      if (Array.isArray(raw_calls)) {
        for (const entry of raw_calls) {
          // oxlint-disable-next-line no-await-in-loop
          await on_tool_call_delta(entry)
        }
      }
    }
    const raw_finish: unknown = Reflect.get(choice, 'finish_reason')
    if (typeof raw_finish === 'string') {
      finish_reason = raw_finish
      // The finish frame is the wire's word that every argument delta has
      // arrived, so open tool calls close here, before the usage frame.
      await close_tool_calls()
    }
  }

  return {
    async handle_data(data: string): Promise<void> {
      if (data === '[DONE]') {
        if (done) return
        done = true
        // Covers servers that omit the finish_reason frame; a no-op after one.
        await close_tool_calls()
        await dispatch({
          kind: 'step_finish',
          step_index,
          finish_reason: map_chat_finish_reason(finish_reason),
          usage: map_chat_usage(usage, dialect),
        })
        return
      }
      let frame: unknown
      try {
        frame = JSON.parse(data)
      } catch {
        throw new provider_error(`${dialect.name} native: stream frame is not valid JSON`)
      }
      if (frame === null || typeof frame !== 'object') return
      const raw_usage: unknown = Reflect.get(frame, 'usage')
      if (raw_usage !== null && typeof raw_usage === 'object') usage = raw_usage
      const choices: unknown = Reflect.get(frame, 'choices')
      const choice: unknown = Array.isArray(choices) ? choices[0] : undefined
      if (choice !== null && choice !== undefined && typeof choice === 'object') {
        await on_choice(choice)
      }
    },
    complete(): TurnResult {
      if (!done) {
        throw new provider_error(
          `${dialect.name} native: stream ended before [DONE]; the result would be truncated`,
        )
      }
      const ordered = in_index_order()
      const message: Record<string, unknown> = {
        role: 'assistant',
        content: text.length > 0 || ordered.length === 0 ? text : null,
      }
      if (ordered.length > 0) {
        message['tool_calls'] = ordered.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      }
      return parse_chat_completion(
        { choices: [{ index: 0, message, finish_reason: finish_reason ?? null }], usage },
        dialect,
      )
    },
  }
}

/**
 * Drain a streaming chat/completions response through the shared
 * framed-stream consumer: SSE framing feeding the aggregator, which
 * dispatches chunks through req.dispatch_chunk as they arrive. The
 * aggregator's `handle_data` name is part of its exported API, so it is
 * adapted to the consumer's `handle` shape here rather than renamed.
 */
async function consume_sse_response(
  response: Response,
  req: TurnRequest,
  dialect: OpenAICompatibleDialect,
): Promise<TurnResult> {
  return consume_framed_stream(response, req, dialect.name, create_sse_decoder(), (dispatch) => {
    const aggregator = create_chat_stream_aggregator(dialect, req.step_index, dispatch)
    return { handle: aggregator.handle_data, complete: aggregator.complete }
  })
}

// 'structured_output' is intentionally absent (schema rides the prompt +
// parse + repair loop); image parts are unmapped on this transport.
const SUPPORTED: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
  'reasoning',
])

/**
 * Build a native OpenAI-compatible adapter from a dialect: validates the
 * dialect's api_key when auth is `bearer`, normalizes base_url, and wires
 * invoke_turn to POST /chat/completions directly (streamed or not) through
 * the mappers above.
 */
export const create_openai_compatible_adapter = (
  dialect: OpenAICompatibleDialect,
): NativeProviderAdapter => {
  if (dialect.auth.kind === 'bearer' && dialect.auth.api_key.length === 0) {
    throw new engine_config_error(
      `${dialect.name} provider requires a non-empty api_key`,
      dialect.name,
    )
  }
  const base_url = dialect.base_url.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...dialect.extra_headers,
  }
  if (dialect.auth.kind === 'bearer') {
    headers['authorization'] = `Bearer ${dialect.auth.api_key}`
  }

  return {
    kind: 'native',
    name: dialect.name,
    async invoke_turn(req: TurnRequest): Promise<TurnResult> {
      return invoke_http_turn(
        req,
        dialect.name,
        {
          url: `${base_url}/chat/completions`,
          headers,
          build_body: () => build_chat_completions_body(req, dialect),
        },
        {
          stream: (response) => consume_sse_response(response, req, dialect),
          parse: (payload) => parse_chat_completion(payload, dialect),
        },
      )
    },
    supports: (capability) => SUPPORTED.has(capability),
  }
}
