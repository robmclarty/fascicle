/**
 * The transport of `web_fetch`: one GET over `node:http` or `node:https`
 * that connects only to an address the checks in `address.ts` passed.
 *
 * The global `fetch` resolves a host name again after any check a caller
 * makes, so this file resolves once, checks, and pins the connection to the
 * checked address. Redirects and decompression are its own to do for the
 * same reason.
 */

import { lookup as dns_lookup } from 'node:dns/promises'
import { request as http_request } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as https_request } from 'node:https'
import type { LookupFunction } from 'node:net'
import type { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { check_addresses, check_url, literal_address } from './address.js'
import type {
  ResolveHost,
  ResolvedAddress,
  TransportHead,
  TransportRequest,
  TransportResponse,
  WebDeps,
} from './types.js'

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

const ACCEPT = 'text/html, text/markdown;q=0.9, text/plain;q=0.9, */*;q=0.5'

const ACCEPT_ENCODING = 'gzip, deflate, br'

/** One fetch in flight: what it was asked, how it resolves, when it stops, and the hop it is on. */
type Call = {
  readonly request: TransportRequest
  readonly resolve: ResolveHost
  readonly stop: AbortSignal
  /** The URL of the hop in flight, which the timeout and abort messages name. */
  href: string
}

/** One hop's exchange: the request, kept so that it can be destroyed, and the response that answered it. */
type Exchange = {
  readonly outgoing: ClientRequest
  readonly incoming: IncomingMessage
}

/** What a body came to once it was decompressed and held to the limit. */
type Body = {
  readonly body: Buffer
  readonly truncated: boolean
}

/**
 * A URL as a message may show it, with any username and password taken out.
 *
 * Text that does not parse is returned as it came, since nothing in it can
 * be told apart as a credential.
 */
function without_credentials(text: string, base?: string): string {
  if (!URL.canParse(text, base)) return text
  const url = new URL(text, base)
  if (url.username === '' && url.password === '') return text
  url.username = ''
  url.password = ''
  return url.href
}

/** The message of a thrown value, whatever was thrown. */
function message_of(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The error for a hop that failed below HTTP: DNS, the connection, or a socket that closed early. */
function unreachable(href: string, cause: unknown): Error {
  return new Error(`web_fetch could not reach ${href}: ${message_of(cause)}`, { cause })
}

/**
 * The error a stopped call rejects with: the timeout's, the caller's own
 * abort reason when that is an error, and otherwise one that names the hop.
 */
function stop_error(stop: AbortSignal, href: string): Error {
  const reason: unknown = stop.reason
  return reason instanceof Error ? reason : new Error(`web_fetch was cancelled before ${href} answered`)
}

/**
 * Wait on a promise, but no longer than the call is allowed to go on.
 *
 * A resolver has no way to be cancelled, so a stop leaves it running and
 * stops waiting on it.
 */
function until_stopped<T>(work: Promise<T>, call: Call): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    /** Reject with the stop's error. */
    const on_stop = (): void => {
      reject(stop_error(call.stop, call.href))
    }
    if (call.stop.aborted) {
      on_stop()
      return
    }
    call.stop.addEventListener('abort', on_stop, { once: true })
    work.then(resolve, reject).finally(() => {
      call.stop.removeEventListener('abort', on_stop)
    })
  })
}

/** Resolve a host name through the system resolver, to every address it has. */
async function default_resolve(hostname: string): Promise<ReadonlyArray<ResolvedAddress>> {
  const entries = await dns_lookup(hostname, { all: true })
  return entries.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }))
}

/**
 * A `lookup` that ignores the name it is asked for and answers the one
 * address that was checked.
 *
 * This is the pin. Node calls `lookup` when it opens the socket, and a second
 * real resolution there could answer a different address than the one the
 * check saw.
 */
function pinned_lookup(pinned: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }])
      return
    }
    callback(null, pinned.address, pinned.family)
  }
}

/** Wrap a refusal from `address.ts` in the redirect that led to it. A refusal of the first URL passes unchanged. */
function refusal(cause: unknown, hop: number, from: string | undefined, location: string): unknown {
  if (hop === 0 || from === undefined) return cause
  return new Error(
    `redirect ${String(hop)} (${from} to ${without_credentials(location, from)}) was refused: ${message_of(cause)}`,
    { cause },
  )
}

/** Run one of the checks in `address.ts`, naming the redirect when it refuses one. */
function checked<T>(check: () => T, hop: number, from: string | undefined, location: string): T {
  try {
    return check()
  } catch (error) {
    throw refusal(error, hop, from, location)
  }
}

/**
 * Every address a URL's host has: the literal when the host is one, and one
 * resolution otherwise.
 *
 * Node never calls `lookup` for an IP host, so a literal is checked as it
 * stands and connected to as it stands.
 */
async function addresses_of(url: URL, call: Call): Promise<ReadonlyArray<ResolvedAddress>> {
  const literal = literal_address(url)
  if (literal !== undefined) return [literal]
  try {
    return await until_stopped(call.resolve(url.hostname), call)
  } catch (error) {
    if (call.stop.aborted) throw stop_error(call.stop, call.href)
    throw unreachable(url.href, error)
  }
}

/**
 * Send one GET to the pinned address and wait for the response's head.
 *
 * `agent: false` gives the request a socket of its own, so no kept-alive
 * connection from an earlier call can stand in for the pinned one.
 */
function open(url: URL, pinned: ResolvedAddress, call: Call): Promise<Exchange> {
  return new Promise<Exchange>((resolve, reject) => {
    if (call.stop.aborted) {
      reject(stop_error(call.stop, call.href))
      return
    }
    const send = url.protocol === 'https:' ? https_request : http_request
    const outgoing = send(url, {
      method: 'GET',
      agent: false,
      lookup: pinned_lookup(pinned),
      headers: {
        'user-agent': call.request.user_agent,
        accept: ACCEPT,
        'accept-encoding': ACCEPT_ENCODING,
      },
    })
    /** Destroy the request with the stop's error, which comes back through its `error` event. */
    const on_stop = (): void => {
      outgoing.destroy(stop_error(call.stop, call.href))
    }
    // The listener stays on for the life of the request: a socket error
    // after the head arrived would otherwise be an uncaught exception.
    outgoing.on('error', (error) => {
      call.stop.removeEventListener('abort', on_stop)
      reject(call.stop.aborted ? stop_error(call.stop, call.href) : unreachable(url.href, error))
    })
    outgoing.on('response', (incoming) => {
      call.stop.removeEventListener('abort', on_stop)
      resolve({ outgoing, incoming })
    })
    call.stop.addEventListener('abort', on_stop, { once: true })
    outgoing.end()
  })
}

/** The stream that undoes a `Content-Encoding`, or undefined when the body passes through as it is. */
function decoder_for(encoding: string | undefined): (Readable & NodeJS.WritableStream) | undefined {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip()
    case 'deflate':
      return createInflate()
    case 'br':
      return createBrotliDecompress()
    default:
      return undefined
  }
}

/**
 * Read a response's body, decompressed, up to `fetch_limit_bytes`.
 *
 * The count is of bytes after decompression, and the read stops at the
 * limit, so a small compressed body can't unpack into a large one in memory.
 * The body counts as truncated only once a byte past the limit has shown up,
 * which is why a body of exactly the limit is whole.
 */
function read_body(exchange: Exchange, href: string, call: Call): Promise<Body> {
  return new Promise<Body>((resolve, reject) => {
    const { incoming, outgoing } = exchange
    const limit = call.request.fetch_limit_bytes
    const encoding = incoming.headers['content-encoding']
    const decoder = decoder_for(encoding)
    const source: Readable = decoder === undefined ? incoming : incoming.pipe(decoder)
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    /** Settle once, then let go of the listener, the decoder, and the socket. */
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      call.stop.removeEventListener('abort', on_stop)
      settle()
      if (decoder !== undefined) {
        incoming.unpipe(decoder)
        decoder.destroy()
      }
      outgoing.destroy()
    }
    /** Resolve with what was read. */
    const done = (truncated: boolean): void => {
      finish(() => {
        resolve({ body: Buffer.concat(chunks), truncated })
      })
    }
    /** Reject with an error. */
    const fail = (error: Error): void => {
      finish(() => {
        reject(error)
      })
    }
    /** Reject with the stop's error. */
    function on_stop(): void {
      fail(stop_error(call.stop, call.href))
    }

    source.on('data', (chunk: Buffer) => {
      if (settled) return
      const room = limit - total
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room))
        done(true)
        return
      }
      chunks.push(chunk)
      total += chunk.length
    })
    source.on('end', () => {
      done(false)
    })
    incoming.on('error', (error) => {
      fail(unreachable(href, error))
    })
    incoming.on('close', () => {
      if (!incoming.complete) fail(unreachable(href, new Error('the connection closed before the body ended')))
    })
    if (decoder !== undefined) {
      decoder.on('error', (error) => {
        fail(
          new Error(`web_fetch could not decode the ${String(encoding)} body of ${href}: ${error.message}`, {
            cause: error,
          }),
        )
      })
    }
    call.stop.addEventListener('abort', on_stop, { once: true })
  })
}

/** The `Location` of a response that is a redirect to follow, or undefined when the response is the final one. */
function redirect_location(incoming: IncomingMessage): string | undefined {
  const location = incoming.headers.location
  if (location === undefined || location === '') return undefined
  return REDIRECT_STATUSES.has(incoming.statusCode ?? 0) ? location : undefined
}

/**
 * Walk the hops of one fetch until a response that is not a redirect, and
 * read that one.
 *
 * Every hop goes through the same three steps before a socket opens: the URL
 * checks, one resolution, and the address check on all that it answered.
 * Nothing is carried from one hop to the next but the URL.
 */
async function follow(call: Call): Promise<TransportResponse> {
  const { request } = call
  let text = request.url
  let from: string | undefined
  let start = text
  for (let hop = 0; ; hop += 1) {
    if (call.stop.aborted) throw stop_error(call.stop, call.href)
    const location = text
    const base = from
    const url = checked(() => check_url(location, request.policy, base), hop, base, location)
    call.href = url.href
    if (hop === 0) start = url.href
    const addresses = await addresses_of(url, call)
    const pinned = checked(() => check_addresses(url, addresses, request.policy), hop, base, location)
    const exchange = await open(url, pinned, call)
    try {
      const next = redirect_location(exchange.incoming)
      if (next === undefined) {
        const head: TransportHead = {
          url: url.href,
          status: exchange.incoming.statusCode ?? 0,
          content_type: exchange.incoming.headers['content-type'],
        }
        request.check_head?.(head)
        const body = await read_body(exchange, url.href, call)
        return { ...head, ...body }
      }
      if (hop >= request.max_redirects) {
        throw new Error(
          `${start} redirected more than ${String(request.max_redirects)} times; redirect ${String(hop + 1)} pointed at ${without_credentials(next, url.href)}`,
        )
      }
      text = next
      from = url.href
    } finally {
      exchange.outgoing.destroy()
    }
  }
}

/**
 * GET a URL, following redirects, and return the final response with its
 * body decompressed and held to `fetch_limit_bytes`.
 *
 * `timeout_ms` bounds the whole call (resolution, every hop, and the body),
 * and `abort` stops it at any point. Any HTTP status is returned, never
 * thrown.
 */
export function fetch_url(request: TransportRequest, deps: WebDeps = {}): Promise<TransportResponse> {
  const controller = new AbortController()
  const call: Call = {
    request,
    resolve: deps.resolve ?? default_resolve,
    stop: controller.signal,
    href: without_credentials(request.url),
  }
  /** Stop the call with the caller's own reason, which `stop_error` turns into the error to reject with. */
  const on_abort = (): void => {
    controller.abort(request.abort.reason)
  }
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`${call.href} did not answer within ${String(request.timeout_ms)} ms, so web_fetch gave up`),
    )
  }, request.timeout_ms)
  if (request.abort.aborted) on_abort()
  else request.abort.addEventListener('abort', on_abort, { once: true })
  return follow(call).finally(() => {
    clearTimeout(timer)
    request.abort.removeEventListener('abort', on_abort)
  })
}
