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
 * The message under a JSON error envelope's `error` key, or undefined when
 * the shape carries none worth surfacing.
 */
function error_field_message(parsed: unknown): string | undefined {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: the
  // caller's try/catch already funnels every non-object parse to the raw
  // snippet, so this guard only narrows unknown -> object for Reflect.get;
  // forcing it either way throws-and-catches to the same fallback (equivalent).
  if (parsed === null || typeof parsed !== 'object') return undefined
  const error: unknown = Reflect.get(parsed, 'error')
  if (typeof error === 'string' && error.length > 0) return error
  // Stryker disable next-line ConditionalExpression,LogicalOperator: same as
  // above -- a non-object error still reaches the raw-snippet fallback via the
  // catch or the message-not-a-string check, so both boundaries are equivalent.
  if (error === null || typeof error !== 'object') return undefined
  const message: unknown = Reflect.get(error, 'message')
  return typeof message === 'string' && message.length > 0 ? message : undefined
}

/**
 * Pull a human-readable message out of a non-2xx body. The native wires share
 * one envelope family: Anthropic sends `{ type: 'error', error: { message } }`,
 * OpenAI-style wires send `{ error: { message } }`, and Ollama sends
 * `{ error: "message" }` (with the nested shape appearing behind proxies), so
 * one parser accepts a string or a `{ message }` object under `error` and
 * falls back to the raw body, truncated to 300 chars.
 */
function extract_error_message(body: string): string {
  if (body.length === 0) return '(empty body)'
  let message: string | undefined
  try {
    message = error_field_message(JSON.parse(body))
  } catch {
    // Not JSON; fall through to the raw snippet.
  }
  if (message !== undefined) return message
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
 * A user abort surfaces as the fetch/reader AbortError; retry_turn converts
 * it via its own signal check, so it is rethrown untouched. Everything else
 * is a transport failure wrapped in the `kind: 'network'` shape the shared
 * classify_provider_error marks retryable.
 */
function rethrow_network_failure(err: unknown, abort: AbortSignal, provider: string): never {
  if (abort.aborted) throw err
  const detail = err instanceof Error ? err.message : String(err)
  throw Object.assign(new Error(`${provider} native: network failure: ${detail}`), {
    kind: 'network',
  })
}

/**
 * Run one native turn over HTTP: POST the dialect's body, map a non-2xx to
 * the retry stack's shapes, and hand the response to the dialect's stream or
 * JSON consumer. `build_body` is called inside the network try/catch on
 * purpose, so a mapper that throws surfaces as a retryable network failure
 * rather than escaping the turn unclassified.
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
  },
): Promise<TurnResult> {
  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.build_body()),
      signal: req.abort,
    })
  } catch (err: unknown) {
    rethrow_network_failure(err, req.abort, provider)
  }
  if (!response.ok) throw await response_error(response, provider)
  if (req.stream) return consume.stream(response)
  const payload: unknown = await response.json()
  return consume.parse(payload)
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

/**
 * Partition assistant content parts into the text runs and tool calls the
 * wire mappers serialize separately.
 */
export function split_assistant_parts(parts: ReadonlyArray<AssistantContentPart>): {
  texts: string[]
  tool_parts: Array<Extract<AssistantContentPart, { type: 'tool_call' }>>
} {
  const texts: string[] = []
  const tool_parts: Array<Extract<AssistantContentPart, { type: 'tool_call' }>> = []
  for (const part of parts) {
    if (part.type === 'text') texts.push(part.text)
    else tool_parts.push(part)
  }
  return { texts, tool_parts }
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
