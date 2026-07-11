/**
 * OpenAI-compatible native core (depth-1 raw HTTP).
 *
 * One `chat/completions` implementation parameterized by a dialect config
 * (D1): base_url, auth strategy, extra headers, stream-usage behavior,
 * token-limit field name, and usage tolerance (D10). The `openai`,
 * `openrouter`, and `lmstudio` factories each build a dialect and share this
 * core; pointing base_url at any compat server (including Ollama's /v1)
 * rides the same path.
 *
 * Zero `ai` / `@ai-sdk/*` in the module graph (C3). The adapter owns
 * request/response mapping only: generate.ts wraps invoke_turn in retry +
 * classification + abort, so failures are thrown in shapes the shared
 * classify_provider_error already understands (`status` + `responseHeaders`
 * for HTTP transients, `kind: 'network'` for transport failures), never
 * retried here. Schema requests ride the engine's prompt + parse + repair
 * loop, so `TurnRequest.schema` is intentionally unread. Streaming (SSE)
 * lands in the next step; until then the adapter does not claim the
 * 'streaming' capability.
 */

import { z } from 'zod'
import type {
  AssistantContentPart,
  EffortLevel,
  FinishReason,
  Message,
  Tool,
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
import type { NativeProviderAdapter, ProviderCapability } from './types.js'

/**
 * Per-dialect wire knobs (Appendix A1). `name` is the provider name the
 * adapter reports and the `provider_options` key it reads, kept stable across
 * transports so pricing keys and usage fields carry over (C6).
 * `tolerant_usage` marks backends whose usage may be absent or approximate
 * (lmstudio, ollama-compat): the mapper returns zeroed totals instead of
 * throwing (D10).
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
 * Effort map per Appendix A4: the wire enum is `low | medium | high` only, so
 * `xhigh` and `max` clamp to `high`, the same clamp as the ai_sdk transport's
 * `reasoningEffort`. `none` omits the field entirely. Non-reasoning models
 * ignore the field server-side; the adapter does not model-sniff.
 */
export const OPENAI_COMPATIBLE_REASONING_EFFORT: Record<
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

function to_assistant_message(content: string | AssistantContentPart[]): ChatMessage {
  if (typeof content === 'string') return { role: 'assistant', content }
  const text_parts: string[] = []
  const tool_calls: ChatToolCall[] = []
  for (const part of content) {
    if (part.type === 'text') {
      text_parts.push(part.text)
    } else {
      tool_calls.push({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.input) },
      })
    }
  }
  const text = text_parts.join('')
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
  const out: ChatMessage[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: message.content })
        break
      case 'user':
        out.push({ role: 'user', content: to_user_content(message.content, provider) })
        break
      case 'assistant':
        out.push(to_assistant_message(message.content))
        break
      case 'tool':
        out.push({
          role: 'tool',
          tool_call_id: message.tool_call_id,
          content: message.content,
        })
        break
    }
  }
  return out
}

export function to_chat_tools(tools: ReadonlyArray<Tool>): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.input_schema),
    },
  }))
}

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
    // backends that ignore the flag fall under tolerant_usage (D10).
    if (dialect.stream_include_usage) body['stream_options'] = { include_usage: true }
  }
  // provider_options.<name> is raw wire-format passthrough (snake_case
  // chat/completions keys), shallow-merged last so an explicit user key beats
  // every derived field: the effort-derived reasoning_effort, the token
  // limit, sampling params (D9). Wire keys are the user asserting they know
  // the wire; the adapter does not reconcile interactions the API rejects.
  const passthrough = req.provider_options?.[dialect.name]
  return passthrough === undefined ? body : { ...body, ...passthrough }
}

export function map_chat_finish_reason(raw: unknown): FinishReason {
  switch (raw) {
    case 'tool_calls':
      return 'tool_calls'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    // stop and anything unrecognized both mean "the model stopped on its own"
    // (Appendix A2).
    default:
      return 'stop'
  }
}

/**
 * Usage map per Appendix A3. prompt_tokens is already INCLUSIVE of cached
 * tokens on this API, unlike Anthropic's exclusive accounting, so a straight
 * copy is correct; compute_cost subtracts the cached portion back out. There
 * is no cache-write concept on this wire. A missing usage object throws under
 * a strict dialect (a hosted API omitting usage is a broken response) and
 * zeroes under a tolerant one (D10).
 */
function read_number(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'number' ? value : undefined
}

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
  // arguments is a JSON string on this wire; some servers send '' for
  // no-argument calls, which means the same as '{}'.
  const raw_args: unknown = Reflect.get(fn, 'arguments')
  let input: unknown = {}
  if (typeof raw_args === 'string' && raw_args.length > 0) {
    try {
      input = JSON.parse(raw_args)
    } catch {
      throw new provider_error(
        `${provider} native: tool_calls arguments for ${name} is not valid JSON`,
      )
    }
  }
  return { id, name, input }
}

/**
 * The one response parser every path feeds (C4): non-stream parses the
 * payload directly, and the streaming aggregator (next step) rebuilds this
 * same payload shape from deltas before calling it.
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

/** OpenAI-style error bodies are `{ error: { message } }`; fall back to the raw body. */
function extract_error_message(body: string): string {
  if (body.length === 0) return '(empty body)'
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object') {
      const error: unknown = Reflect.get(parsed, 'error')
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
 * becomes a typed provider_auth_error, 429/5xx keep `status` +
 * `responseHeaders` so classify_provider_error marks them retryable
 * (rate_limit honoring retry-after, provider_5xx), and any other 4xx is a
 * permanent provider_error that surfaces as-is.
 */
async function response_error(response: Response, provider: string): Promise<Error> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    // Body is best-effort detail; classification needs only the status.
  }
  const detail = extract_error_message(body)
  const status = response.status
  if (status === 401) {
    return new provider_auth_error(
      provider,
      `${provider} authentication failed (401): ${detail}`,
    )
  }
  if (status === 429 || status >= 500) {
    const retry_after = response.headers.get('retry-after')
    return Object.assign(
      new Error(`${provider} API error ${status}: ${detail}`),
      { status },
      retry_after !== null ? { responseHeaders: { 'retry-after': retry_after } } : {},
    )
  }
  return new provider_error(`${provider} API error ${status}: ${detail}`, { status, body })
}

/**
 * A user abort surfaces as the fetch AbortError; retry_turn converts it via
 * its own signal check, so it is rethrown untouched. Everything else is a
 * transport failure wrapped in the `kind: 'network'` shape the shared
 * classify_provider_error marks retryable.
 */
function rethrow_network_failure(err: unknown, abort: AbortSignal, provider: string): never {
  if (abort.aborted) throw err
  const detail = err instanceof Error ? err.message : String(err)
  throw Object.assign(new Error(`${provider} native: network failure: ${detail}`), {
    kind: 'network',
  })
}

// 'streaming' joins this set when the SSE path lands in the next step;
// 'structured_output' is intentionally absent (schema rides the prompt +
// parse + repair loop); image parts are unmapped on this transport.
const SUPPORTED: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'reasoning',
])

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
      if (req.stream) {
        throw new provider_capability_error(
          dialect.name,
          'streaming',
          'the native SSE path is not implemented yet; the capability gate in generate.ts keeps engine calls off it',
        )
      }
      let response: Response
      try {
        response = await fetch(`${base_url}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(build_chat_completions_body(req, dialect)),
          signal: req.abort,
        })
      } catch (err: unknown) {
        rethrow_network_failure(err, req.abort, dialect.name)
      }
      if (!response.ok) throw await response_error(response, dialect.name)
      const payload: unknown = await response.json()
      return parse_chat_completion(payload, dialect)
    },
    supports: (capability) => SUPPORTED.has(capability),
  }
}
