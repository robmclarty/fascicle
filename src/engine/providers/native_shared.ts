/**
 * Shared plumbing for the native (raw-HTTP) provider adapters.
 *
 * Everything here is wire-neutral: how a turn travels HTTP (POST, non-2xx
 * mapping, stream-vs-JSON dispatch), how streamed bytes become framed
 * payloads, and the engine-message folds the 1:1 wires share. Each adapter
 * keeps what is genuinely its own dialect (request bodies, response parsers,
 * stream aggregators) and delegates the rest here, so the three adapters
 * cannot drift apart on retry classification or stream draining. This module
 * imports nothing from `ai` or `@ai-sdk/*` and nothing from the adapters, so
 * every adapter can import it cycle-free.
 */

import type {
  AssistantContentPart,
  Message,
  ProviderInit,
  StreamChunk,
  TurnRequest,
  TurnResult,
  UserContentPart,
} from '../types.js'
import { provider_auth_error, provider_error } from '../errors.js'

/**
 * `value` when it is a non-empty string, or undefined.
 */
function non_empty_string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The message under a JSON error envelope's `error` key, or else its
 * top-level `message`, or undefined when the shape carries none worth
 * surfacing.
 */
function error_field_message(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const error: unknown = Reflect.get(parsed, 'error')
  if (typeof error === 'string' && error.length > 0) return error
  if (error !== null && typeof error === 'object') {
    const message = non_empty_string(Reflect.get(error, 'message'))
    if (message !== undefined) return message
  }
  return non_empty_string(Reflect.get(parsed, 'message'))
}

/**
 * The message a non-2xx JSON body carries, or undefined when the body isn't
 * JSON or carries none. The wires share one envelope family: Anthropic sends
 * `{ type: 'error', error: { message } }`, OpenAI-style wires send
 * `{ error: { message } }`, Ollama sends `{ error: "message" }` (with the
 * nested shape appearing behind proxies), and Bedrock sends `{ message }`, so
 * one parser accepts a string or a `{ message }` object under `error`, and
 * then a top-level `message`. The engine's classifier reads an AI SDK error's
 * `responseBody` through it too.
 */
export function error_body_message(body: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // Not JSON, so it carries no message.
  }
  return error_field_message(parsed)
}

/**
 * Pull a human-readable message out of a non-2xx body: the one its JSON
 * carries (see error_body_message), or else the raw body, truncated to 300
 * chars.
 */
function extract_error_message(body: string): string {
  if (body.length === 0) return '(empty body)'
  const message = error_body_message(body)
  if (message !== undefined) return message
  return body.length > 300 ? `${body.slice(0, 300)}...` : body
}

const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'lmstudio'])

/** The model name in Ollama's `model 'x' not found` reply, either quote. */
const OLLAMA_MISSING_MODEL = /model ['"]([^'"]+)['"] not found/

/**
 * `detail` without the one period a provider's sentence ends on, so that an
 * action can follow it after a colon. A `...` truncation tail keeps its dots.
 */
function strip_trailing_period(detail: string): string {
  return detail.replace(/(?<!\.)\.$/, '')
}

/**
 * What to do about a 404: pull the model, when Ollama names one it doesn't
 * have, and otherwise check the model id and where `base_url` points, since
 * a path the provider doesn't serve answers 404 too.
 */
function not_found_action(provider: string, detail: string): string {
  const missing = provider === 'ollama' ? OLLAMA_MISSING_MODEL.exec(detail)?.[1] : undefined
  if (missing !== undefined) return `run ollama pull ${missing}`
  return `check the model id against the ${provider} model list, and that base_url points at the ${provider} API`
}

/**
 * What a caller does about a non-retryable status, or '' for a status whose
 * fix only the provider's own text can say, such as a 400 or a 422. The
 * ollama and lmstudio providers send no credentials, so a 401 from either
 * comes from something in front of the server.
 */
function status_action(provider: string, status: number, detail: string): string {
  if (status === 401) {
    return LOCAL_PROVIDERS.has(provider)
      ? `the ${provider} provider sends no credentials, so check that base_url reaches the server without a proxy that asks for them`
      : `check providers.${provider}.api_key`
  }
  if (status === 403) return 'the credentials lack access to this model or endpoint'
  if (status === 404) return not_found_action(provider, detail)
  return ''
}

/**
 * The error a status that won't be retried becomes, on either transport: a
 * 401 is a provider_auth_error, and any other status a provider_error that
 * carries it and the body. The message leads with the provider and the
 * status, then the provider's own text, then what to do when the status says
 * it. The native transport's response_error and the engine's ai_sdk
 * classifier both build theirs here, so a wrong key or a wrong model id reads
 * the same whichever transport the call took, and `cause` holds the SDK's
 * error on the ai_sdk one.
 */
export function non_retryable_status_error(
  provider: string,
  status: number,
  detail: string,
  metadata: { body?: string | undefined; cause?: unknown } = {},
): provider_auth_error | provider_error {
  const action = status_action(provider, status, detail)
  const tail = action === '' ? detail : `${strip_trailing_period(detail)}: ${action}`
  if (status === 401) {
    return new provider_auth_error(provider, `${provider} authentication failed (401): ${tail}`, {
      cause: metadata.cause,
    })
  }
  return new provider_error(`${provider} API error ${status}: ${tail}`, { status, ...metadata })
}

/**
 * Map a non-2xx response to what the engine's retry stack expects: 429/5xx
 * keep `status`, `body`, and `responseHeaders` so classify_provider_error
 * marks them retryable (rate_limit honoring retry-after, provider_5xx) and
 * the exhausted error still has the body, and any other status is the
 * permanent error that non_retryable_status_error builds, which surfaces
 * as-is.
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
  if (status === 429 || status >= 500) {
    const retry_after = response.headers.get('retry-after')
    return Object.assign(
      new Error(`${provider} API error ${status}: ${detail}`),
      { status, body },
      retry_after !== null ? { responseHeaders: { 'retry-after': retry_after } } : {},
    )
  }
  return non_retryable_status_error(provider, status, detail, { body })
}

/**
 * A transport failure in the `kind: 'network'` shape that the shared
 * classify_provider_error marks retryable. A stream that ends before its
 * closing event throws it too, since a cut-off stream is a dropped
 * connection, so the engine retries it whenever nothing consumed its chunks.
 */
export function network_failure(message: string): Error {
  return Object.assign(new Error(message), { kind: 'network' })
}

/**
 * A user abort surfaces as the fetch/reader AbortError; retry_turn converts
 * it via its own signal check, so it is rethrown untouched. Everything else
 * is a transport failure wrapped as a network_failure.
 */
function rethrow_network_failure(err: unknown, abort: AbortSignal, provider: string): never {
  if (abort.aborted) throw err
  const detail = err instanceof Error ? err.message : String(err)
  throw network_failure(`${provider} native: network failure: ${detail}`)
}

/**
 * The response's media type, lowercased and without its parameters, or ''
 * when it names none.
 */
function media_type(response: Response): string {
  const header = response.headers.get('content-type') ?? ''
  return (header.split(';')[0] ?? '').trim().toLowerCase()
}

/**
 * Read a non-stream response body and parse it as JSON. A read that fails
 * partway is a transport failure, wrapped as network the way a failed stream
 * read is; a body that arrives whole but does not parse is a permanent
 * provider_error naming what came back.
 */
async function read_json_body(
  response: Response,
  abort: AbortSignal,
  provider: string,
): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch (err: unknown) {
    rethrow_network_failure(err, abort, provider)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new provider_error(
      `${provider} native: response body is not valid JSON: check that base_url points at the ${provider} API (body: ${extract_error_message(text)})`,
    )
  }
}

/**
 * Run one native turn over HTTP: POST the dialect's body, map a non-2xx to
 * the retry stack's shapes, and hand the response to the dialect's stream or
 * JSON consumer. A streamed request whose reply doesn't arrive as the
 * dialect's stream media type (`text/event-stream`, or NDJSON for Ollama) is
 * read as a whole JSON body, so a server that answers with JSON still works,
 * and a page that isn't JSON fails with the `base_url` hint rather than as a
 * cut-off stream. `build_body` runs before the network try/catch, so a mapper
 * that rejects the request (e.g., a provider_capability_error for a part the
 * wire cannot carry) propagates unchanged instead of being retried as a
 * network failure. `req.on_wire`, when the call captures the wire, sees the
 * URL and the body object just before the body is serialized, and never a
 * header.
 */
export async function invoke_http_turn(
  req: TurnRequest,
  provider: string,
  request: {
    url: string
    headers: Record<string, string>
    build_body: () => Record<string, unknown>
  },
  consume: {
    stream: (response: Response) => Promise<TurnResult>
    parse: (payload: unknown) => TurnResult
    /** The media type that a streamed reply arrives as. */
    stream_media_type: string
  },
): Promise<TurnResult> {
  const built = request.build_body()
  req.on_wire?.({ url: request.url, body: built })
  const body = JSON.stringify(built)
  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body,
      signal: req.abort,
    })
  } catch (err: unknown) {
    rethrow_network_failure(err, req.abort, provider)
  }
  if (!response.ok) throw await response_error(response, provider)
  if (req.stream && media_type(response) === consume.stream_media_type) {
    return consume.stream(response)
  }
  return consume.parse(await read_json_body(response, req.abort, provider))
}

/**
 * Drain a streaming response: decode bytes, reassemble framed payloads (SSE
 * events or NDJSON lines), and feed them to the dialect's aggregator, which
 * dispatches chunks through req.dispatch_chunk as they arrive. Transport
 * failures mid-read wrap as network errors; aggregator throws (malformed
 * frames, mid-stream error events, a rejecting on_chunk) pass through
 * untouched, with the reader cancelled so the connection is released.
 */
export async function consume_framed_stream(
  response: Response,
  req: TurnRequest,
  provider: string,
  framing: { push: (text: string) => string[]; flush: () => string[] },
  create_aggregator: (dispatch: (chunk: StreamChunk) => Promise<void>) => {
    handle: (data: string) => Promise<void>
    complete: () => TurnResult
  },
): Promise<TurnResult> {
  const body = response.body
  if (body === null) {
    throw new provider_error(`${provider} native: streaming response has no body`)
  }
  const aggregator = create_aggregator(req.dispatch_chunk ?? (async (): Promise<void> => {}))
  const reader = body.getReader()
  const text_decoder = new TextDecoder()

  const next_bytes = async (): Promise<Uint8Array | undefined> => {
    let step: Awaited<ReturnType<typeof reader.read>>
    try {
      step = await reader.read()
    } catch (err: unknown) {
      rethrow_network_failure(err, req.abort, provider)
    }
    return step.done ? undefined : step.value
  }

  // Sequential awaits are the contract here: chunk order is an engine
  // invariant and each frame mutates aggregator state, so no parallelism.
  try {
    while (true) {
      const bytes = await next_bytes()
      if (bytes === undefined) break
      for (const data of framing.push(text_decoder.decode(bytes, { stream: true }))) {
        await aggregator.handle(data)
      }
    }
  } finally {
    // Frees the connection when an error exits the loop early; a no-op on a
    // fully drained stream.
    void reader.cancel().catch(() => {})
  }
  const tail = [...framing.push(text_decoder.decode()), ...framing.flush()]
  for (const data of tail) {
    await aggregator.handle(data)
  }
  return aggregator.complete()
}

/**
 * Incremental newline framing shared by the SSE and NDJSON decoders: buffer
 * decoded text across arbitrary chunk boundaries, hand each completed line
 * (CR trimmed) to `handle_line`, and on flush hand over an unterminated tail
 * line, then `on_flush` for state a decoder holds across lines (an SSE event
 * never closed by a blank line).
 */
export function create_line_splitter(
  handle_line: (line: string, out: string[]) => void,
  on_flush?: (out: string[]) => void,
): { push: (text: string) => string[]; flush: () => string[] } {
  let buffer = ''

  const take_line = (raw: string, out: string[]): void => {
    handle_line(raw.endsWith('\r') ? raw.slice(0, -1) : raw, out)
  }

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
      on_flush?.(out)
      return out
    },
  }
}

/**
 * Decode a tool call's wire `arguments` string into the engine's input value:
 * non-empty JSON parses (bad JSON is a provider_error naming the tool), and
 * an absent or empty value means `{}`, the shape some servers send for
 * no-argument calls. The Ollama wire's structured-object arguments are its
 * caller's business before this runs.
 */
export function parse_tool_call_arguments(
  raw_args: unknown,
  provider: string,
  tool_name: string,
): unknown {
  if (typeof raw_args === 'string' && raw_args.length > 0) {
    try {
      return JSON.parse(raw_args)
    } catch {
      throw new provider_error(
        `${provider} native: tool_calls arguments for ${tool_name} is not valid JSON`,
      )
    }
  }
  return {}
}

/**
 * Fold engine messages into a wire's message array by role. Serves the wires
 * whose messages map 1:1 in place (chat/completions, Ollama's /api/chat); the
 * Messages API's system-hoisting and role-merging rules live in its own
 * mapper instead.
 */
export function map_messages_by_role<m>(
  messages: ReadonlyArray<Message>,
  wire: {
    system: (content: string) => m
    user: (content: string | UserContentPart[]) => m
    assistant: (content: string | AssistantContentPart[]) => m
    tool: (message: Extract<Message, { role: 'tool' }>) => m
  },
): m[] {
  const out: m[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        out.push(wire.system(message.content))
        break
      case 'user':
        out.push(wire.user(message.content))
        break
      case 'assistant':
        out.push(wire.assistant(message.content))
        break
      case 'tool':
        out.push(wire.tool(message))
        break
    }
  }
  return out
}

type ReasoningPart = Extract<AssistantContentPart, { type: 'reasoning' }>

/**
 * Whether a reasoning part is one this provider may send back: only a part
 * carrying data under the provider's own key goes. A part keyed for another
 * vendor stays behind, so a `fallback` never hands one vendor's signature to
 * another, and so does a part with no data, whose text alone is what a
 * signing wire refuses.
 */
export function is_own_reasoning(part: ReasoningPart, key: string): boolean {
  return part.provider_options?.[key] !== undefined
}

/**
 * Partition assistant content parts into the text runs, tool calls, and
 * reasoning the wire mappers serialize separately. `reasoning` holds only
 * the parts `provider` may send back, in order (see is_own_reasoning). An
 * opaque part belongs to the provider that sent it, and these formats carry
 * no such block, so it is skipped.
 */
export function split_assistant_parts(
  parts: ReadonlyArray<AssistantContentPart>,
  provider: string,
): {
  texts: string[]
  tool_parts: Array<Extract<AssistantContentPart, { type: 'tool_call' }>>
  reasoning: ReasoningPart[]
} {
  const texts: string[] = []
  const tool_parts: Array<Extract<AssistantContentPart, { type: 'tool_call' }>> = []
  const reasoning: ReasoningPart[] = []
  for (const part of parts) {
    if (part.type === 'text') texts.push(part.text)
    else if (part.type === 'tool_call') tool_parts.push(part)
    else if (part.type === 'reasoning' && is_own_reasoning(part, provider)) reasoning.push(part)
  }
  return { texts, tool_parts, reasoning }
}

/**
 * Read the api_key and base_url every OpenAI-compatible dialect starts from:
 * a missing or non-string api_key becomes '' (the core's empty-key guard owns
 * the throw), and an absent base_url falls back to the dialect's default.
 */
export function read_dialect_init(
  init: ProviderInit,
  default_base_url: string,
): { api_key: string; base_url: string } {
  return {
    api_key: typeof init.api_key === 'string' ? init.api_key : '',
    base_url:
      typeof init.base_url === 'string' && init.base_url.length > 0
        ? init.base_url
        : default_base_url,
  }
}
