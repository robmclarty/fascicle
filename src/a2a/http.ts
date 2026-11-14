/**
 * The agent as a web `fetch` handler: the card, and JSON-RPC over HTTP.
 *
 * It follows the SDK's own Express `jsonRpcHandler` step for step, minus
 * Express. Each request's context carries the caller, the `A2A-Version`
 * header, and the `A2A-Extensions` header, and the version is checked
 * against the card before the body goes to the SDK, since the SDK's
 * transport handler doesn't check it.
 *
 * A streaming method answers with server-sent events, one `data:` frame for
 * each JSON-RPC response. Its first result is awaited before the response
 * commits to a stream, so an error that comes before the stream starts goes
 * back as a plain JSON-RPC error. A client that disconnects stops the stream
 * it was reading and nothing else: the handler keeps reading the task's
 * events, because the SDK writes each one to the task store as it's read,
 * and A2A keeps a dropped connection apart from a cancel.
 *
 * Three answers sit outside JSON-RPC, because they're about the request and
 * not the method: 401 for a caller `authenticate` refuses, 413 for a body
 * over the limit, and 429 for a new task while the agent is at capacity.
 */

import type { AgentCard } from '@a2a-js/sdk'
import type { A2ARequestHandler, ServerCallContext } from '@a2a-js/sdk/server'
import { is_record } from '#schema'
import type { A2aServerSdk } from './sdk_loader.js'
import type { A2aUser } from './types.js'

export type HttpConfig = {
  readonly sdk: A2aServerSdk
  readonly card: AgentCard
  readonly handler: A2ARequestHandler
  readonly authenticate: ((request: Request) => A2aUser | null | Promise<A2aUser | null>) | undefined
  readonly rpc_path: string
  readonly max_body_bytes: number
  /** Whether the agent has room for one more task. */
  readonly has_room: () => boolean
  /** Whether the agent has closed. */
  readonly is_closed: () => boolean
}

type RpcResponse = { readonly jsonrpc: string; readonly id: string | number | null; readonly error?: unknown }

const CARD_PATH = '/.well-known/agent-card.json'
const CARD_MAX_AGE_SECONDS = 300
const JSON_TYPE = 'application/json'
const STARTS_A_TASK: ReadonlySet<unknown> = new Set(['SendMessage', 'SendStreamingMessage'])
// JSON-RPC's own codes for a body that isn't JSON and for a server fault.
const PARSE_ERROR = -32700
const INTERNAL_ERROR = -32603

/**
 * A JSON response.
 */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': JSON_TYPE, ...headers } })
}

/**
 * A plain refusal that isn't JSON-RPC, with the reason in its body. The
 * body has no `error` field, which a JSON-RPC client would read as an error
 * object and find empty.
 */
function refusal(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json({ message }, status, headers)
}

/**
 * Read a request's body as text, or `undefined` once it passes `limit`
 * bytes. A declared length over the limit is refused without reading.
 */
async function read_body(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return undefined
  if (request.body === null) return ''
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for await (const chunk of request.body) {
    size += chunk.byteLength
    if (size > limit) return undefined
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

/**
 * Whether a JSON-RPC body is a message that would start a task (one that
 * names no task of its own).
 */
function starts_a_task(body: unknown): boolean {
  if (!is_record(body) || !STARTS_A_TASK.has(body['method'])) return false
  const params = body['params']
  const message = is_record(params) ? params['message'] : undefined
  return !(is_record(message) && typeof message['taskId'] === 'string' && message['taskId'] !== '')
}

/**
 * The id of a JSON-RPC request, for the error that answers it.
 */
function id_of(body: unknown): string | number | null {
  const id = is_record(body) ? body['id'] : null
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

/**
 * Whether a value is the stream of responses a streaming method returns.
 */
function is_stream(value: unknown): value is AsyncGenerator<RpcResponse, void, undefined> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

/**
 * Build the fetch handler for one agent.
 */
export function http_handler(config: HttpConfig): (request: Request) => Promise<Response> {
  const { sdk, card, handler } = config
  const transport = new sdk.server.JsonRpcTransportHandler(handler)
  const card_body = JSON.stringify(sdk.wire.AgentCard.toJSON(card))

  const error_response = (id: string | number | null, err: unknown): RpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: sdk.server.JsonRpcTransportHandler.mapToJSONRPCError(err),
  })

  // Send a stream's responses as server-sent events. The pump keeps reading
  // after the client has gone, so the SDK still records what the task does.
  const event_stream = (
    first: RpcResponse | undefined,
    rest: AsyncIterator<RpcResponse>,
    id: string | number | null,
    headers: Record<string, string>,
  ): Response => {
    const encoder = new TextEncoder()
    let open = true
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (frame: string): void => {
          if (open) controller.enqueue(encoder.encode(frame))
        }
        const pump = async (): Promise<void> => {
          try {
            if (first !== undefined) send(sdk.wire.formatSSEEvent(first))
            for (let next = await rest.next(); next.done !== true; next = await rest.next()) {
              send(sdk.wire.formatSSEEvent(next.value))
            }
          } catch (err) {
            send(sdk.wire.formatSSEErrorEvent(error_response(id, err)))
          }
          if (open) controller.close()
          open = false
        }
        void pump()
      },
      cancel: () => {
        open = false
      },
    })
    return new Response(body, { status: 200, headers: { ...sdk.wire.SSE_HEADERS, ...headers } })
  }

  // An absent `A2A-Version` header reads as 0.3, which is the SDK's rule.
  const context_for = (request: Request, user: A2aUser): ServerCallContext => {
    const version = request.headers.get(sdk.wire.A2A_VERSION_HEADER)
    return new sdk.server.ServerCallContext({
      requestedExtensions: sdk.wire.Extensions.parseServiceParameter(
        request.headers.get(sdk.wire.HTTP_EXTENSION_HEADER) ?? undefined,
      ),
      user: { isAuthenticated: user.authenticated, userName: user.name },
      ...(version === null ? {} : { requestedVersion: version }),
      state: new Map<string, unknown>([[sdk.server.STATE_HEADERS_KEY, Object.fromEntries(request.headers)]]),
    })
  }

  // Hand a parsed body to the SDK and shape whatever comes back.
  const dispatch = async (body: unknown, context: ServerCallContext): Promise<Response> => {
    const id = id_of(body)
    try {
      sdk.server.validateVersion(context.requestedVersion, card, 'JSONRPC')
    } catch (err) {
      return json(error_response(id, err))
    }
    // The transport handler validates the body's shape itself.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const result = await transport.handle(body as Record<string, unknown>, context)
    const activated = context.activatedExtensions
    const headers: Record<string, string> =
      activated === undefined ? {} : { [sdk.wire.HTTP_EXTENSION_HEADER]: activated.join(',') }
    if (!is_stream(result)) return json(result, 200, headers)
    let first: IteratorResult<RpcResponse, void>
    try {
      first = await result.next()
    } catch (err) {
      return json(error_response(id, err), 200, headers)
    }
    return event_stream(first.done === true ? undefined : first.value, result, id, headers)
  }

  const rpc = async (request: Request): Promise<Response> => {
    const user = config.authenticate === undefined ? { name: '', authenticated: false } : await config.authenticate(request)
    if (user === null) return refusal(401, 'unauthorized')
    // A body with no JSON content type is refused, a missing one included.
    // A web page can post such a body to localhost without the browser
    // asking first, and it can't post one that says it's JSON.
    const type = request.headers.get('content-type') ?? ''
    if (type.split(';', 1)[0]?.trim().toLowerCase() !== JSON_TYPE) {
      const unsupported = new sdk.errors.ContentTypeNotSupportedError(
        `Unsupported Content-Type "${type}"; expected ${JSON_TYPE}.`,
      )
      return json(error_response(null, unsupported))
    }
    const text = await read_body(request, config.max_body_bytes)
    if (text === undefined) return refusal(413, `the request body is over ${config.max_body_bytes} bytes`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Invalid JSON payload.' } })
    }
    if (starts_a_task(body) && !config.has_room()) {
      return refusal(429, 'the agent is running as many tasks as it takes at once: try again shortly', {
        'retry-after': '1',
      })
    }
    try {
      return await dispatch(body, context_for(request, user))
    } catch (err) {
      const mapped = error_response(id_of(body), err)
      const fault = is_record(mapped.error) && mapped.error['code'] === INTERNAL_ERROR
      return json(mapped, fault ? 500 : 200)
    }
  }

  return async (request) => {
    if (config.is_closed()) return refusal(503, 'the agent has closed')
    const path = new URL(request.url).pathname
    if (path === CARD_PATH) {
      if (request.method !== 'GET') return refusal(405, 'the agent card takes GET', { allow: 'GET' })
      return new Response(card_body, {
        status: 200,
        headers: { 'content-type': JSON_TYPE, 'cache-control': `public, max-age=${CARD_MAX_AGE_SECONDS}` },
      })
    }
    if (path !== config.rpc_path) return refusal(404, `nothing is served at ${path}`)
    if (request.method !== 'POST') return refusal(405, 'JSON-RPC takes POST', { allow: 'POST' })
    return rpc(request)
  }
}
