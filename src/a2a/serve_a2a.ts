/**
 * Process glue for serving a flow as an A2A agent over `node:http`.
 *
 * Binds `a2a_agent` to a real server: each request becomes a web `Request`
 * with its body streamed, and the agent's `Response` is piped back out,
 * server-sent events included. The server binds to `127.0.0.1` unless
 * `host` says otherwise, so reaching the network is a choice someone makes.
 *
 * SIGTERM and SIGINT stop new connections, close the agent (which aborts
 * every drive and waits for each to settle), dispose the engine, and exit
 * with the signal's code. The handlers are one-shot, so a second Ctrl-C
 * falls through to Node's default and kills the process outright when a
 * shutdown hangs.
 *
 * Stdout isn't the protocol here, so unlike `serve_acp`, the console stays
 * where it is.
 *
 * Excluded from mutation testing as process glue (see stryker.config.mjs);
 * the spawn test in `__tests__/e2e/` exercises it for real.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { constants } from 'node:os'
import { Readable } from 'node:stream'
import { a2a_agent } from './a2a_agent.js'
import type { A2aAgent, A2aServer, ServeA2aConfig } from './types.js'

const DEFAULT_HOST = '127.0.0.1'

/**
 * The web `Request` for a Node request, with its body streamed and its
 * signal aborted when the connection closes before the response has ended.
 */
function web_request(incoming: IncomingMessage, outgoing: ServerResponse, base: string): Request {
  const gone = new AbortController()
  outgoing.on('close', () => {
    if (!outgoing.writableFinished) gone.abort()
  })
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  const has_body = incoming.method !== 'GET' && incoming.method !== 'HEAD'
  return new Request(new URL(incoming.url ?? '/', base), {
    method: incoming.method ?? 'GET',
    headers,
    signal: gone.signal,
    ...(has_body ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
  })
}

/**
 * Write a web `Response` out through a Node response, a chunk at a time, so
 * a stream reaches the client as it's produced.
 */
async function send(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body === null) {
    outgoing.end()
    return
  }
  const reader = response.body.getReader()
  outgoing.on('close', () => {
    void reader.cancel().catch(() => {})
  })
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    outgoing.write(value)
  }
  outgoing.end()
}

/**
 * Answer one Node request with the agent's `fetch`. A handler that throws
 * answers 500, or just ends a response that has already begun.
 */
async function answer(agent: A2aAgent, incoming: IncomingMessage, outgoing: ServerResponse, base: string): Promise<void> {
  try {
    await send(await agent.fetch(web_request(incoming, outgoing, base)), outgoing)
  } catch {
    if (outgoing.headersSent) {
      outgoing.end()
      return
    }
    outgoing.writeHead(500, { 'content-type': 'application/json' })
    // No `error` field: a JSON-RPC client would read one as an error object.
    outgoing.end('{"message":"internal error"}')
  }
}

/**
 * Start listening, and resolve once the server has its address.
 */
function listen(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      // A server that listens on a port has an address record, never a pipe's path.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      resolve(server.address() as AddressInfo)
    })
  })
}

/**
 * Serve a flow as an A2A agent over `node:http` until `close`, SIGTERM, or
 * SIGINT. Resolves the address it bound, the agent's `resume` for outside
 * events, and a `close` that stops taking connections, closes the agent, and
 * disposes the engine. A signal does the same, then exits with the signal's
 * code.
 */
export async function serve_a2a<i, o>(config: ServeA2aConfig<i, o>): Promise<A2aServer> {
  const agent = await a2a_agent(config)
  const host = config.host ?? DEFAULT_HOST
  let base = `http://${host}`
  const server = createServer((incoming, outgoing) => {
    void answer(agent, incoming, outgoing, base)
  })
  const address = await listen(server, config.port, host)
  base = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`

  let closing: Promise<void> | undefined
  const shut_down = async (): Promise<void> => {
    const stopped = new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    await agent.close()
    // Streams that a closed agent no longer feeds would hold the server open.
    server.closeAllConnections()
    await stopped
    await config.engine?.dispose()
  }
  const on_signal = (signal: NodeJS.Signals): void => {
    void close().finally(() => process.exit(128 + constants.signals[signal]))
  }
  const close = (): Promise<void> => {
    process.off('SIGTERM', on_signal)
    process.off('SIGINT', on_signal)
    closing ??= shut_down()
    return closing
  }
  process.once('SIGTERM', on_signal)
  process.once('SIGINT', on_signal)
  return { url: base, resume: agent.resume, close }
}
