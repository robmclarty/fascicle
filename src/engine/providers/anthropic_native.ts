/**
 * Native Anthropic provider adapter (raw HTTP).
 *
 * Talks to the Messages API directly over global fetch with zero `ai` /
 * `@ai-sdk/*` in its module graph. It owns request/response mapping only:
 * generate.ts wraps invoke_turn in retry + classification + abort, so
 * failures are thrown in shapes the shared classify_provider_error already
 * understands (`status` + `responseHeaders` for HTTP transients,
 * `kind: 'network'` for transport failures) instead of being re-classified
 * or retried here.
 *
 * Selected via `transport: 'native'` on the anthropic provider init. The
 * adapter name stays 'anthropic' so DEFAULT_PRICING keys and UsageTotals
 * fields keep working across transports. Schema requests ride the engine's
 * prompt + parse + repair loop, so `TurnRequest.schema` is intentionally
 * unread. Streaming hand-rolls the SSE parse; the aggregator rebuilds the
 * non-stream payload shape and feeds it through the same
 * parse_messages_response, so streamed and non-streamed results are equal by
 * construction rather than by parallel code paths.
 */

import { to_json_schema } from '#schema'
import type {
  AssistantContentPart,
  EffortLevel,
  FinishReason,
  Message,
  ProviderInit,
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
import { consume_framed_stream, invoke_http_turn } from './native_shared.js'
import { create_sse_decoder } from './sse_native.js'
import type { NativeProviderAdapter, ProviderCapability } from './types.js'

/**
 * Effort level to extended-thinking budget tokens. Lives here (not in
 * anthropic.ts) because both transports map effort from this table and the
 * ai_sdk factory already imports this module for transport dispatch; the
 * reverse import would be a cycle.
 */
export const ANTHROPIC_THINKING_BUDGETS: Record<EffortLevel, number> = {
  none: 0,
  low: 1024,
  medium: 5000,
  high: 20000,
  xhigh: 32000,
  max: 64000,
}

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Matches the @ai-sdk/anthropic baseURL convention (origin + /v1) so a
 * base_url configured for the ai_sdk transport keeps pointing at the same
 * place when the transport flips to native.
 */
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'

/**
 * The Messages API requires max_tokens on every request. When extended
 * thinking is enabled the budget counts against max_tokens, so the default
 * rides on top of the thinking budget rather than being swallowed by it.
 */
const DEFAULT_MAX_TOKENS = 4096

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

/**
 * Wrap non-blank text in a single text block; blank text maps to no blocks,
 * since the API rejects empty text blocks.
 */
function text_blocks(text: string): AnthropicContentBlock[] {
  return text.trim().length > 0 ? [{ type: 'text', text }] : []
}

/**
 * Map user message content to Messages-API text blocks, dropping empty text
 * (the API rejects empty blocks). Image parts throw a capability error: they
 * are not mapped on this transport.
 */
function to_user_blocks(content: string | UserContentPart[]): AnthropicContentBlock[] {
  if (typeof content === 'string') return text_blocks(content)
  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (part.type === 'image') {
      throw new provider_capability_error(
        'anthropic',
        'image_input',
        "image parts are not mapped on the native transport; use transport: 'ai_sdk'",
      )
    }
    blocks.push(...text_blocks(part.text))
  }
  return blocks
}

/**
 * Map assistant message content to Messages-API blocks: text parts become
 * text blocks (empties dropped), tool-call parts become tool_use blocks.
 */
function to_assistant_blocks(
  content: string | AssistantContentPart[],
): AnthropicContentBlock[] {
  if (typeof content === 'string') return text_blocks(content)
  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (part.type === 'text') {
      blocks.push(...text_blocks(part.text))
    } else {
      blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input })
    }
  }
  return blocks
}

/**
 * Map fascicle Message[] to Messages-API shape: leading system messages hoist
 * to the top-level `system` string, tool messages become `tool_result` blocks
 * on a user turn, and empty text blocks are dropped (the API rejects them).
 * generate.ts already hoists leading system into TurnRequest.system, so the
 * hoist here only fires when the adapter is driven directly.
 */
export function to_anthropic_messages(messages: ReadonlyArray<Message>): {
  system: string | undefined
  messages: AnthropicMessage[]
} {
  const system_parts: string[] = []
  const out: AnthropicMessage[] = []

  const push_blocks = (role: 'user' | 'assistant', blocks: AnthropicContentBlock[]): void => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    // The Messages API requires alternating roles; consecutive same-role
    // entries (parallel tool results, or a tool result followed by user
    // text) merge into one message.
    if (last?.role === role) {
      last.content.push(...blocks)
      return
    }
    out.push({ role, content: blocks })
  }

  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        if (out.length > 0) {
          throw new provider_capability_error(
            'anthropic',
            'mid_conversation_system_messages',
            'the Messages API accepts system text only before the first user/assistant turn',
          )
        }
        system_parts.push(message.content)
        break
      }
      case 'user': {
        push_blocks('user', to_user_blocks(message.content))
        break
      }
      case 'assistant': {
        push_blocks('assistant', to_assistant_blocks(message.content))
        break
      }
      case 'tool': {
        push_blocks('user', [
          { type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content },
        ])
        break
      }
    }
  }

  return {
    system: system_parts.length > 0 ? system_parts.join('\n\n') : undefined,
    messages: out,
  }
}

/**
 * Map fascicle tool definitions to the Messages-API tool shape, converting
 * each input schema to JSON Schema.
 */
export function to_anthropic_tools(
  tools: ReadonlyArray<Tool>,
): Array<{ name: string; description: string; input_schema: unknown }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: to_json_schema(tool.input_schema),
  }))
}

/**
 * Build the Messages-API request body for one turn: mapped messages and
 * tools, the effort-derived thinking block, the required max_tokens default,
 * and the `provider_options.anthropic` wire passthrough merged last.
 */
export function build_messages_body(req: TurnRequest): Record<string, unknown> {
  const { system: hoisted_system, messages } = to_anthropic_messages(req.messages)
  const system_parts = [req.system, hoisted_system].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  )
  const budget = ANTHROPIC_THINKING_BUDGETS[req.effort]
  const thinking_enabled = budget > 0

  const body: Record<string, unknown> = {
    model: req.model_id,
    messages,
    max_tokens:
      req.max_tokens ?? (thinking_enabled ? budget + DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS),
  }
  if (system_parts.length > 0) body['system'] = system_parts.join('\n\n')
  if (req.tools.length > 0) body['tools'] = to_anthropic_tools(req.tools)
  if (req.stream) body['stream'] = true
  if (thinking_enabled) {
    body['thinking'] = { type: 'enabled', budget_tokens: budget }
  } else {
    // The API rejects temperature/top_p alongside extended thinking, so
    // sampling params apply only when thinking is off (parity with the
    // @ai-sdk/anthropic backend, which strips them the same way). The inner
    // guards already gate each key, so the branch is a plain else rather than
    // a redundant `else if` on the same two conditions.
    if (req.temperature !== undefined) body['temperature'] = req.temperature
    if (req.top_p !== undefined) body['top_p'] = req.top_p
  }
  // provider_options.anthropic is raw wire-format passthrough (snake_case
  // Messages-API keys, not the ai_sdk transport's camelCase spellings),
  // shallow-merged last so an explicit user key beats every derived field:
  // the effort-derived thinking block, the max_tokens default, sampling
  // params. The adapter does not reconcile interactions the API rejects
  // (for example, a passthrough temperature alongside thinking); wire keys are the
  // user asserting they know the wire.
  const passthrough = req.provider_options?.['anthropic']
  // Stryker disable next-line ConditionalExpression: spreading an undefined
  // passthrough is a no-op, so forcing the merge branch ({ ...body, ...undefined })
  // deep-equals this fast-path return; only the merge branch is observable.
  return passthrough === undefined ? body : { ...body, ...passthrough }
}

/**
 * Map the Messages-API stop_reason to the engine's FinishReason.
 */
export function map_anthropic_stop_reason(raw: unknown): FinishReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'refusal':
      return 'content_filter'
    // end_turn, stop_sequence, pause_turn, and anything unrecognized all
    // mean "the model stopped on its own".
    default:
      return 'stop'
  }
}

/**
 * Map the Messages-API usage object to UsageTotals.
 *
 * The API reports input_tokens EXCLUSIVE of cache reads and writes, while
 * compute_cost subtracts both back out of UsageTotals.input_tokens to price
 * the fresh remainder. So the inclusive total is the sum of all three; a
 * straight copy would silently under-count input cost on cached calls.
 */
export function map_anthropic_usage(raw: unknown): UsageTotals {
  if (raw === null || typeof raw !== 'object') {
    return { input_tokens: 0, output_tokens: 0 }
  }
  const read = (key: string): number | undefined => {
    const value: unknown = Reflect.get(raw, key)
    return typeof value === 'number' ? value : undefined
  }
  const cache_read = read('cache_read_input_tokens')
  const cache_write = read('cache_creation_input_tokens')
  const totals: UsageTotals = {
    input_tokens: (read('input_tokens') ?? 0) + (cache_read ?? 0) + (cache_write ?? 0),
    output_tokens: read('output_tokens') ?? 0,
  }
  if (cache_read !== undefined) totals.cached_input_tokens = cache_read
  if (cache_write !== undefined) totals.cache_write_tokens = cache_write
  return totals
}

/**
 * Read the id and name a tool_use block must carry, throwing a
 * provider_error naming `where` the malformed block appeared.
 */
function read_tool_use_identity(block: object, where: string): { id: string; name: string } {
  const id: unknown = Reflect.get(block, 'id')
  const name: unknown = Reflect.get(block, 'name')
  if (typeof id !== 'string' || typeof name !== 'string') {
    throw new provider_error(`anthropic native: malformed tool_use block in ${where}`)
  }
  return { id, name }
}

/**
 * Fold one response `content` block into the text/tool_call accumulators.
 * Text blocks append their string; tool_use blocks contribute a call whose id
 * and name are validated by read_tool_use_identity; thinking /
 * redacted_thinking blocks have no TurnResult field and are skipped.
 */
function push_content_block(
  block: unknown,
  text_parts: string[],
  tool_calls: Array<{ id: string; name: string; input: unknown }>,
): void {
  if (block === null || typeof block !== 'object') return
  const type: unknown = Reflect.get(block, 'type')
  if (type === 'text') {
    const text: unknown = Reflect.get(block, 'text')
    if (typeof text === 'string') text_parts.push(text)
    return
  }
  if (type === 'tool_use') {
    const { id, name } = read_tool_use_identity(block, 'response content')
    tool_calls.push({ id, name, input: Reflect.get(block, 'input') })
  }
}

/**
 * Walk a response payload's `content` array into the flat text and tool_call
 * lists a TurnResult carries. A non-array `content` yields empty lists,
 * matching a payload that carried no content blocks.
 */
function collect_content_blocks(content: unknown): {
  text_parts: string[]
  tool_calls: Array<{ id: string; name: string; input: unknown }>
} {
  const text_parts: string[] = []
  const tool_calls: Array<{ id: string; name: string; input: unknown }> = []
  if (Array.isArray(content)) {
    for (const block of content) push_content_block(block, text_parts, tool_calls)
  }
  return { text_parts, tool_calls }
}

/**
 * Parse a non-stream Messages-API response payload into a TurnResult. The
 * stream aggregator rebuilds this same payload shape and feeds it here too,
 * so both paths share one parser.
 */
export function parse_messages_response(payload: unknown): TurnResult {
  if (payload === null || typeof payload !== 'object') {
    throw new provider_error('anthropic native: response payload is not a JSON object')
  }
  const { text_parts, tool_calls } = collect_content_blocks(Reflect.get(payload, 'content'))
  return {
    text: text_parts.join(''),
    tool_calls,
    finish_reason: map_anthropic_stop_reason(Reflect.get(payload, 'stop_reason')),
    usage: map_anthropic_usage(Reflect.get(payload, 'usage')),
  }
}

/**
 * Mid-stream `error` events reuse the HTTP status classification:
 * overloaded_error is the SSE analog of a 529, api_error of a 500, and
 * rate_limit_error of a 429, so classify_provider_error sees the transients
 * it already retries. Anything else is a permanent provider_error. Whether a
 * retry actually happens stays retry_turn's call: once chunks have streamed
 * it refuses, exactly as on the ai_sdk path.
 */
function stream_event_error(event: object): Error {
  const error: unknown = Reflect.get(event, 'error')
  let error_type = 'unknown'
  let message = '(no message)'
  if (error !== null && typeof error === 'object') {
    const raw_type: unknown = Reflect.get(error, 'type')
    if (typeof raw_type === 'string' && raw_type.length > 0) error_type = raw_type
    const raw_message: unknown = Reflect.get(error, 'message')
    if (typeof raw_message === 'string' && raw_message.length > 0) message = raw_message
  }
  const detail = `anthropic stream error (${error_type}): ${message}`
  let status: number | undefined
  if (error_type === 'overloaded_error') status = 529
  else if (error_type === 'api_error') status = 500
  else if (error_type === 'rate_limit_error') status = 429
  if (status !== undefined) return Object.assign(new Error(detail), { status })
  return new provider_error(detail)
}

/**
 * Read the `index` field every stream event carries, identifying which
 * content block (text or tool_use) the event applies to.
 */
function read_block_index(event: object): number {
  const index: unknown = Reflect.get(event, 'index')
  if (typeof index !== 'number') {
    throw new provider_error('anthropic native: stream event is missing its block index')
  }
  return index
}

/**
 * Consume parsed Messages-stream events, dispatching StreamChunks as they
 * arrive and rebuilding the non-stream response payload as it goes: text
 * deltas accumulate into synthetic text blocks, tool_use input arrives as raw
 * JSON text (input_json_delta) held per open block and parsed at
 * content_block_stop. complete() feeds the synthetic payload through
 * parse_messages_response, which is what makes the streamed TurnResult equal
 * the non-streamed one by construction. A stream that ends without
 * message_stop is truncated output, so complete() fails loud instead of
 * returning a partial turn.
 */
function create_stream_aggregator(
  step_index: number,
  dispatch: (chunk: StreamChunk) => Promise<void>,
): {
  handle: (data: string) => Promise<void>
  complete: () => TurnResult
} {
  type SyntheticToolUse = { type: 'tool_use'; id: string; name: string; input: unknown }
  // Stryker disable next-line ArrayDeclaration: a seeded initial element is dropped by
  // parse_messages_response's block guard, so a non-empty content array is unobservable.
  const content: Array<{ type: 'text'; text: string } | SyntheticToolUse> = []
  const open_text = new Map<number, { type: 'text'; text: string }>()
  const open_tools = new Map<number, { block: SyntheticToolUse; json: string }>()
  const usage: Record<string, number> = {}
  let stop_reason: string | undefined
  let stopped = false

  // message_delta usage (cumulative output_tokens) overlays message_start
  // usage (input + cache fields); nested non-numeric containers are skipped.
  const merge_usage = (raw: unknown): void => {
    if (raw === null || typeof raw !== 'object') return
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number') usage[key] = value
    }
  }

  const on_block_start = async (event: object): Promise<void> => {
    const index = read_block_index(event)
    const block: unknown = Reflect.get(event, 'content_block')
    if (block === null || typeof block !== 'object') return
    const type: unknown = Reflect.get(block, 'type')
    if (type === 'text') {
      const initial: unknown = Reflect.get(block, 'text')
      const synthetic = {
        type: 'text' as const,
        text: typeof initial === 'string' ? initial : '',
      }
      content.push(synthetic)
      open_text.set(index, synthetic)
      return
    }
    if (type === 'tool_use') {
      const { id, name } = read_tool_use_identity(block, 'stream')
      const synthetic: SyntheticToolUse = {
        type: 'tool_use',
        id,
        name,
        input: Reflect.get(block, 'input') ?? {},
      }
      content.push(synthetic)
      open_tools.set(index, { block: synthetic, json: '' })
      await dispatch({ kind: 'tool_call_start', id, name, step_index })
    }
    // thinking / redacted_thinking blocks carry no TurnResult state; their
    // deltas dispatch reasoning chunks directly.
  }

  const on_block_delta = async (event: object): Promise<void> => {
    const index = read_block_index(event)
    const delta: unknown = Reflect.get(event, 'delta')
    if (delta === null || typeof delta !== 'object') return
    const type: unknown = Reflect.get(delta, 'type')
    if (type === 'text_delta') {
      const text: unknown = Reflect.get(delta, 'text')
      const open = open_text.get(index)
      if (typeof text !== 'string' || open === undefined) return
      open.text += text
      await dispatch({ kind: 'text', text, step_index })
      return
    }
    if (type === 'thinking_delta') {
      const thinking: unknown = Reflect.get(delta, 'thinking')
      if (typeof thinking === 'string') {
        await dispatch({ kind: 'reasoning', text: thinking, step_index })
      }
      return
    }
    if (type === 'input_json_delta') {
      const partial: unknown = Reflect.get(delta, 'partial_json')
      const open = open_tools.get(index)
      if (typeof partial !== 'string' || open === undefined) return
      open.json += partial
      await dispatch({
        kind: 'tool_call_input_delta',
        id: open.block.id,
        delta: partial,
        step_index,
      })
    }
    // signature_delta and future delta kinds have no engine chunk; dropped.
  }

  const on_block_stop = async (event: object): Promise<void> => {
    const index = read_block_index(event)
    const open = open_tools.get(index)
    open_text.delete(index)
    if (open === undefined) return
    open_tools.delete(index)
    if (open.json.length > 0) {
      try {
        open.block.input = JSON.parse(open.json)
      } catch {
        throw new provider_error(
          `anthropic native: tool_use input for ${open.block.name} is not valid JSON`,
        )
      }
    }
    await dispatch({
      kind: 'tool_call_end',
      id: open.block.id,
      input: open.block.input,
      step_index,
    })
  }

  return {
    async handle(data: string): Promise<void> {
      let event: unknown
      try {
        event = JSON.parse(data)
      } catch {
        throw new provider_error('anthropic native: stream event is not valid JSON')
      }
      if (event === null || typeof event !== 'object') return
      switch (Reflect.get(event, 'type')) {
        case 'message_start': {
          const message: unknown = Reflect.get(event, 'message')
          if (message !== null && typeof message === 'object') {
            merge_usage(Reflect.get(message, 'usage'))
          }
          break
        }
        case 'content_block_start':
          await on_block_start(event)
          break
        case 'content_block_delta':
          await on_block_delta(event)
          break
        case 'content_block_stop':
          await on_block_stop(event)
          break
        case 'message_delta': {
          const delta: unknown = Reflect.get(event, 'delta')
          if (delta !== null && typeof delta === 'object') {
            const raw: unknown = Reflect.get(delta, 'stop_reason')
            if (typeof raw === 'string') stop_reason = raw
          }
          merge_usage(Reflect.get(event, 'usage'))
          break
        }
        case 'message_stop':
          stopped = true
          await dispatch({
            kind: 'step_finish',
            step_index,
            finish_reason: map_anthropic_stop_reason(stop_reason),
            usage: map_anthropic_usage(usage),
          })
          break
        case 'error':
          throw stream_event_error(event)
        // ping and unrecognized future event types are dropped on purpose.
        default:
          break
      }
    },
    complete(): TurnResult {
      if (!stopped) {
        throw new provider_error(
          'anthropic native: stream ended before message_stop; the result would be truncated',
        )
      }
      return parse_messages_response({ content, stop_reason, usage })
    },
  }
}

/**
 * Drain a streaming Messages response through the shared framed-stream
 * consumer: SSE framing feeding the aggregator, which dispatches chunks
 * through req.dispatch_chunk as they arrive.
 */
async function consume_sse_response(response: Response, req: TurnRequest): Promise<TurnResult> {
  return consume_framed_stream(response, req, 'anthropic', create_sse_decoder(), (dispatch) =>
    create_stream_aggregator(req.step_index, dispatch),
  )
}

// 'structured_output' is intentionally absent: schema requests ride the
// prompt + parse + repair loop instead of constrained decoding. Image parts
// are unmapped on this transport.
const SUPPORTED: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
  'reasoning',
])

/**
 * Build the native Anthropic adapter: validates the required api_key,
 * normalizes base_url, and wires invoke_turn to POST /messages directly
 * (streamed or not) through the mappers above.
 */
export const create_anthropic_native_adapter = (
  init: ProviderInit,
): NativeProviderAdapter => {
  const api_key = typeof init.api_key === 'string' ? init.api_key : ''
  if (api_key.length === 0) {
    throw new engine_config_error(
      'anthropic provider requires a non-empty api_key',
      'anthropic',
    )
  }
  const base_url = (
    typeof init.base_url === 'string' && init.base_url.length > 0
      ? init.base_url
      : DEFAULT_BASE_URL
  ).replace(/\/+$/, '')

  return {
    kind: 'native',
    name: 'anthropic',
    async invoke_turn(req: TurnRequest): Promise<TurnResult> {
      return invoke_http_turn(
        req,
        'anthropic',
        {
          url: `${base_url}/messages`,
          headers: {
            'content-type': 'application/json',
            'x-api-key': api_key,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          build_body: () => build_messages_body(req),
        },
        {
          stream: (response) => consume_sse_response(response, req),
          parse: parse_messages_response,
        },
      )
    },
    supports: (capability) => SUPPORTED.has(capability),
  }
}
