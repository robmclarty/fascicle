/**
 * Tiny HTTP server: 5 routes, SSE fan-out, NDJSON ingest.
 *
 *   GET  /              -> static viewer.html
 *   GET  /api/events    -> text/event-stream replaying the ring buffer
 *   GET  /api/snapshot  -> JSON dump of the ring buffer
 *   POST /api/ingest    -> newline-delimited trajectory events (http_logger)
 *   GET  /api/health    -> { ok: true }
 *
 * The server owns nothing but the socket. The broadcaster owns the event
 * history; the static html lives on disk. SSE clients reconnect with
 * `Last-Event-ID` and the server replays anything past their cursor from
 * the ring buffer; older events are gone (bounded memory by design).
 */

import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trajectory_event_schema, type ParsedTrajectoryEvent } from '@repo/core'
import type { Broadcaster } from './broadcast.js'

const SSE_HEARTBEAT_MS = 15_000
const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC_HTML = resolve(HERE, 'static', 'viewer.html')

export type ServerOptions = {
  readonly broadcaster: Broadcaster
  readonly host: string
  readonly port: number
  readonly on_parse_error?: (err: unknown, line: string) => void
}

export type ViewerServer = {
  readonly url: string
  readonly close: () => Promise<void>
}

export function start_server(options: ServerOptions): Promise<ViewerServer> {
  const { broadcaster, host, port, on_parse_error } = options

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`)
    const route = `${req.method ?? 'GET'} ${url.pathname}`

    if (route === 'GET /' || route === 'GET /index.html') {
      serve_static_html(res)
      return
    }
    if (route === 'GET /api/health') {
      send_json(res, 200, { ok: true })
      return
    }
    if (route === 'GET /api/snapshot') {
      send_json(res, 200, { events: broadcaster.snapshot() })
      return
    }
    if (route === 'GET /api/events') {
      handle_sse(req, res, broadcaster)
      return
    }
    if (route === 'POST /api/ingest') {
      handle_ingest(req, res, broadcaster, on_parse_error)
      return
    }
    res.statusCode = 404
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'not_found', route }))
  }

  const http_server = createServer(handler)

  return new Promise((res_ok, res_err) => {
    http_server.once('error', res_err)
    http_server.listen(port, host, () => {
      http_server.removeListener('error', res_err)
      const addr = http_server.address()
      const bound_port =
        addr !== null && typeof addr === 'object' && 'port' in addr ? addr.port : port
      const url = `http://${host}:${bound_port}`
      res_ok({
        url,
        close: () => close_server(http_server),
      })
    })
  })
}

function close_server(server: Server): Promise<void> {
  return new Promise((res_ok, res_err) => {
    server.close((err) => {
      if (err) res_err(err)
      else res_ok()
    })
    server.closeAllConnections?.()
  })
}

function send_json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function serve_static_html(res: ServerResponse): void {
  let size: number
  try {
    size = statSync(STATIC_HTML).size
  } catch {
    res.statusCode = 500
    res.setHeader('content-type', 'text/plain')
    res.end('viewer.html missing')
    return
  }
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(size))
  createReadStream(STATIC_HTML).pipe(res)
}

function handle_sse(req: IncomingMessage, res: ServerResponse, broadcaster: Broadcaster): void {
  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')

  const last_event_id = parse_last_event_id(req.headers['last-event-id'])
  for (const entry of broadcaster.snapshot_after(last_event_id)) {
    write_event(res, entry.id, entry.event)
  }

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, SSE_HEARTBEAT_MS)

  const unsubscribe = broadcaster.subscribe((entry) => {
    write_event(res, entry.id, entry.event)
  })

  const close = (): void => {
    clearInterval(heartbeat)
    unsubscribe()
    if (!res.writableEnded) {
      res.write('event: close\ndata: {}\n\n')
      res.end()
    }
  }

  req.on('close', close)
  req.on('error', close)
}

function parse_last_event_id(value: string | string[] | undefined): number {
  if (typeof value !== 'string') return 0
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function write_event(res: ServerResponse, id: number, event: ParsedTrajectoryEvent): void {
  res.write(`id: ${id}\nevent: trajectory\ndata: ${JSON.stringify(event)}\n\n`)
}

function handle_ingest(
  req: IncomingMessage,
  res: ServerResponse,
  broadcaster: Broadcaster,
  on_parse_error?: (err: unknown, line: string) => void,
): void {
  let buf = ''
  let accepted = 0
  let rejected = 0

  const consume_line = (line: string): void => {
    if (line.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      rejected++
      if (on_parse_error) on_parse_error(err, line)
      return
    }
    const result = trajectory_event_schema.safeParse(parsed)
    if (!result.success) {
      rejected++
      if (on_parse_error) on_parse_error(result.error, line)
      return
    }
    broadcaster.emit(result.data)
    accepted++
  }

  req.setEncoding('utf8')
  req.on('data', (chunk: string) => {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      consume_line(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
    }
  })
  req.on('end', () => {
    if (buf.length > 0) consume_line(buf)
    send_json(res, 200, { accepted, rejected })
  })
  req.on('error', (err: unknown) => {
    if (on_parse_error) on_parse_error(err, '')
    send_json(res, 400, { error: 'bad_request' })
  })
}

export const internals_for_test = { STATIC_HTML, SSE_HEARTBEAT_MS, parse_last_event_id }
