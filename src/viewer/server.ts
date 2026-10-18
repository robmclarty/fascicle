/**
 * Tiny HTTP server: 5 API routes, SSE fan-out, NDJSON ingest, plus the
 * compiled run canvas served as static files.
 *
 *   GET  /api/events      -> text/event-stream, replaying past the client cursor
 *   GET  /api/trajectory  -> the full run history as NDJSON (file, or ring)
 *   GET  /api/snapshot    -> JSON dump of the ring buffer
 *   POST /api/ingest      -> newline-delimited trajectory events (http_logger)
 *   GET  /api/health      -> { ok: true }
 *   GET  /<anything>      -> a file from the compiled app, `/` being index.html
 *
 * The server owns nothing but the socket. The broadcaster owns the recent
 * event ring; the tailed file owns the full history; the canvas is a vite build
 * on disk. A client folds `/api/trajectory` for the whole run and then follows
 * `/api/events`, which replays anything past the cursor it names and streams
 * new events live. The ring is bounded memory by design, so history older than
 * it is served from the file the tail already reads.
 *
 * A server bound to a loopback name answers only requests whose `Host` names
 * loopback too, so a web page can't reach it by rebinding a domain of its own
 * to 127.0.0.1. Ingest is mounted unless the config turns it off, reads only
 * `application/x-ndjson`, and refuses a body past 8 MB.
 */

import { createReadStream, statSync, type Stats } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIPv6 } from 'node:net'
import { dirname, extname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parse_trajectory_event, type ParsedTrajectoryEvent } from '#core'
import type { Broadcaster } from './broadcast.js'

const SSE_HEARTBEAT_MS = 15_000
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The header `/api/trajectory` stamps with the broadcaster's newest id: the
 * seam the client resumes SSE from after folding the history dump. The client
 * carries the same literal (`app/history.ts`); the two ends cannot share a
 * module because the browser bundle must not pull in node builtins.
 */
const CURSOR_HEADER = 'x-fascicle-cursor'

/**
 * Content types for everything the compiled app ships. Anything outside the
 * map is served as an opaque download rather than guessed at, which keeps a
 * stray file from being executed as script by a browser.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

const FALLBACK_CONTENT_TYPE = 'application/octet-stream'

/**
 * The names that keep the viewer on this machine. A server bound to one of
 * them answers only a request whose `Host` names one of them as well.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1'])

/** The one content type `/api/ingest` reads, which is what `http_logger` sends. */
const NDJSON = 'application/x-ndjson'

/**
 * The most bytes one ingest body may carry. `http_logger` posts a single
 * event per request, so only a runaway or hostile client comes near it.
 */
const INGEST_LIMIT_BYTES = 8_000_000

export type ServerConfig = {
  readonly broadcaster: Broadcaster
  readonly host: string
  readonly port: number
  /**
   * Where the compiled canvas lives, defaulting to the bundled
   * `dist/viewer-app`. The tests point it at a fixture directory so the suite
   * never depends on a build having run.
   */
  readonly app_dir?: string
  /**
   * The trajectory file `/api/trajectory` streams as full history. Absent when
   * the server is ingest-fed only, where that route falls back to the ring.
   * Threaded from the tailed `path` by `start_viewer`.
   */
  readonly trajectory_path?: string
  /**
   * Whether `POST /api/ingest` is mounted; default true. Off, the route is a
   * 404 like any path the API doesn't claim, which is how the CLI keeps a
   * viewer that only tails a file from taking posts.
   */
  readonly ingest?: boolean | undefined
  readonly on_parse_error?: (err: unknown, line: string) => void
}

export type ViewerServer = {
  readonly url: string
  /** The port the socket bound, which differs from the requested one for `port: 0`. */
  readonly port: number
  readonly close: () => Promise<void>
}

/**
 * Starts the HTTP server and resolves once it is listening.
 *
 * Wires the five API routes (health, snapshot, trajectory, SSE, ingest) plus
 * the compiled app's static files to a single request handler, and resolves
 * with the bound URL and port and a `close` that shuts the socket down. The
 * `Host` check runs before anything else, then the API routes are matched
 * first and exactly, so no file the canvas ships can ever shadow one.
 */
export function start_server(config: ServerConfig): Promise<ViewerServer> {
  const { broadcaster, host, port, app_dir, trajectory_path, ingest = true, on_parse_error } = config

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!host_allowed(host, req.headers.host)) {
      send_forbidden_host(res, host)
      return
    }
    const route = resolve_route(req, host, port)

    if (route === 'GET /api/health') {
      send_json(res, 200, { ok: true })
      return
    }
    if (route === 'GET /api/snapshot') {
      send_json(res, 200, { events: broadcaster.snapshot() })
      return
    }
    if (route === 'GET /api/trajectory') {
      serve_trajectory(res, broadcaster, trajectory_path)
      return
    }
    if (route === 'GET /api/events') {
      handle_sse(req, res, broadcaster)
      return
    }
    if (ingest && route === 'POST /api/ingest') {
      handle_ingest(req, res, broadcaster, on_parse_error)
      return
    }
    if (route.startsWith('GET /')) {
      serve_app_asset(res, route, app_dir)
      return
    }
    send_not_found(res, route)
  }

  const http_server = createServer(handler)

  return new Promise((res_ok, res_err) => {
    // `listen` can fail (for example, port already in use); reject instead of
    // leaving the returned promise pending forever.
    http_server.once('error', res_err)
    http_server.listen(port, host, () => {
      http_server.removeListener('error', res_err)
      const bound_port = bound_port_of(http_server.address(), port)
      res_ok({
        url: `http://${format_authority(host, bound_port)}`,
        port: bound_port,
        close: () => close_server(http_server),
      })
    })
  })
}

/**
 * Resolves the port a listening server actually bound to.
 *
 * `address()` is only an `AddressInfo` for a TCP listen; it is a path string
 * for a unix socket and `null` before listening, so the fallback covers both.
 * The bound port differs from the requested one only when the caller passed 0
 * and asked the OS to pick a free port.
 */
export function bound_port_of(addr: ReturnType<Server['address']>, fallback: number): number {
  return addr !== null && typeof addr === 'object' && 'port' in addr ? addr.port : fallback
}

/**
 * Joins a host and port into a URL authority, bracketing an IPv6 literal.
 *
 * `http://::1:4242` is not a URL; `http://[::1]:4242` is. A hostname or IPv4
 * address passes through untouched.
 */
function format_authority(host: string, port: number): string {
  return `${isIPv6(host) ? `[${host}]` : host}:${port}`
}

/**
 * Whether `host` is a loopback name, which keeps a server bound to it on this
 * machine.
 */
export function is_loopback_host(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

/**
 * The hostname a `Host` header names, lowercased, with an IPv6 literal's
 * brackets and any port taken off.
 */
function host_name(header: string): string {
  const host = header.toLowerCase()
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'))
  const colon = host.indexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

/**
 * Whether a server bound to `bound` answers a request whose `Host` header is
 * `header`.
 *
 * Bound to a loopback name, it answers only a `Host` that names loopback too,
 * whatever the port, because a page that rebinds a domain of its own to
 * 127.0.0.1 still sends that domain, and would otherwise read every prompt and
 * output in the trajectory. A request with no `Host` is refused as well. Bound
 * anywhere else, it checks nothing: whoever can reach it can read it, which
 * is what the CLI warns about before it binds.
 */
function host_allowed(bound: string, header: string | undefined): boolean {
  if (!is_loopback_host(bound)) return true
  return header !== undefined && is_loopback_host(host_name(header))
}

/**
 * Writes the 403 for a request whose `Host` a loopback-bound server won't
 * answer, naming the names it will.
 */
function send_forbidden_host(res: ServerResponse, bound: string): void {
  send_json(res, 403, {
    error: 'forbidden_host',
    message: `this viewer is bound to ${bound} and answers only a Host of localhost, 127.0.0.1, or ::1; open it by one of those names`,
  })
}

/**
 * Builds a `"METHOD /path"` route key from a request.
 *
 * Resolves the path against the client's `Host` header when it parses, and
 * against the server's own `host`/`port` otherwise. A header can be present yet
 * malformed (`'in valid'`), which `??` cannot catch because it is neither null
 * nor undefined; fed to `new URL` it throws. Trying the header inside a
 * try/catch and falling back to the server's authority keeps route resolution
 * total for any header a client sends.
 */
export function resolve_route(
  req: {
    url?: string | undefined
    method?: string | undefined
    headers: { host?: string | undefined }
  },
  host: string,
  port: number,
): string {
  const method = req.method ?? 'GET'
  const path = req.url ?? '/'
  const header = req.headers.host
  if (header !== undefined) {
    try {
      return `${method} ${new URL(path, `http://${header}`).pathname}`
    } catch {
      // A malformed Host header falls through to the server's own authority.
    }
  }
  return `${method} ${new URL(path, `http://${format_authority(host, port)}`).pathname}`
}

/**
 * Closes the HTTP server and resolves once every connection is torn down.
 */
function close_server(server: Server): Promise<void> {
  return new Promise((res_ok, res_err) => {
    server.close((err) => {
      if (err) res_err(err)
      else res_ok()
    })
    // `close` alone only stops new connections and waits for existing ones
    // (including open SSE streams) to end on their own, which can hang
    // indefinitely. Force them closed so shutdown actually completes.
    // `closeAllConnections` has existed since node 18.2 and `engines.node` is
    // `>=24`, so the call is unconditional.
    server.closeAllConnections()
  })
}

/**
 * Writes a JSON response with the given status code.
 */
function send_json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * Writes the JSON 404 that names the route that missed.
 */
function send_not_found(res: ServerResponse, route: string): void {
  send_json(res, 404, { error: 'not_found', route })
}

/**
 * Handles `GET /api/trajectory` by streaming the whole run history as NDJSON,
 * one event per line, so the client folds the full run before it follows the
 * live tail.
 *
 * The tailed file is the source of truth: its bytes stream straight through,
 * which keeps memory bounded no matter how long the run grew, and a finished
 * `.jsonl` opened with no live producer becomes the same client path as live.
 * An ingest-fed server has no file, so it falls back to the ring buffer, the
 * only history it holds. Either way the response is stamped with the
 * broadcaster's newest id, the seam the client resumes SSE from; the client
 * still takes the larger of that and its own folded count, so a file that ran
 * ahead of the broadcaster is not re-folded.
 */
function serve_trajectory(
  res: ServerResponse,
  broadcaster: Broadcaster,
  trajectory_path: string | undefined,
): void {
  const ring = broadcaster.snapshot()
  res.statusCode = 200
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader(CURSOR_HEADER, String(ring.at(-1)?.id ?? 0))

  // The two guards are nested rather than joined with `&&` on purpose: only a
  // present file reaches `createReadStream`, so a path that is undefined (ingest
  // mode) or set-but-uncreated (a run not yet started) falls through to the
  // ring, the only history such a server holds. `stat_file` returns null
  // for a missing path either way, which keeps the fallthrough total.
  if (trajectory_path !== undefined) {
    if (stat_file(trajectory_path) !== null) {
      stream_file(res, trajectory_path)
      return
    }
  }
  res.end(ring.map((entry) => `${JSON.stringify(entry.event)}\n`).join(''))
}

/**
 * Where the compiled canvas can be, relative to this module.
 *
 * Published, `viewer.js` sits in `dist/` beside `dist/viewer-app/`. Running
 * from source, this module is `src/viewer/server.ts` and the same build output
 * is two levels up in the repo's `dist/`. The two candidates never both exist
 * for the same install, so probing them in order is unambiguous.
 */
function app_dir_candidates(here: string): readonly string[] {
  return [resolve(here, 'viewer-app'), resolve(here, '..', '..', 'dist', 'viewer-app')]
}

/**
 * The compiled app directory, or `null` when the canvas has not been built.
 *
 * A directory only counts once its `index.html` is really there, so a
 * half-written build reads as absent rather than as a directory that 404s
 * every asset.
 */
function resolve_app_dir(override: string | undefined): string | null {
  const candidates = override === undefined ? app_dir_candidates(HERE) : [override]
  return candidates.find((dir) => stat_file(resolve(dir, 'index.html')) !== null) ?? null
}

/**
 * The stats of an existing regular file, or `null` for anything else.
 *
 * One syscall answers both questions the asset route asks: whether to serve
 * the path at all, and what `content-length` to declare. Reading the stats
 * before the stream opens is what keeps a missing file a clean 404 rather
 * than a stream error raised after the headers have gone out.
 */
function stat_file(path: string): Stats | null {
  try {
    const stats = statSync(path)
    return stats.isFile() ? stats : null
  } catch {
    return null
  }
}

/**
 * Resolves a URL path inside the compiled app directory, or `null` when it
 * escapes it.
 *
 * The server is bound to localhost by default, but a browser will happily
 * send `/../../etc/passwd`, so containment is checked on the resolved path
 * rather than trusted from the URL text.
 */
function resolve_app_file(dir: string, url_path: string): string | null {
  const file = resolve(dir, `.${url_path}`)
  if (file !== dir && !file.startsWith(dir + sep)) return null
  return file === dir ? resolve(dir, 'index.html') : file
}

/**
 * Streams one file of the compiled canvas as the response body.
 *
 * A missing app directory is a 500 naming the build step, because the server
 * is fine and the operator forgot to compile; a missing file inside a present
 * app is an ordinary 404.
 */
function serve_app_asset(res: ServerResponse, route: string, override: string | undefined): void {
  const dir = resolve_app_dir(override)
  if (dir === null) {
    res.statusCode = 500
    res.setHeader('content-type', 'text/plain')
    res.end('viewer app not built; run `pnpm build`')
    return
  }

  // The route key is `"<METHOD> <path>"`; splitting on the space keeps the
  // path independent of which method got here, so the GET guard above stays
  // the only thing deciding whether a non-GET reaches the filesystem.
  const file = resolve_app_file(dir, route.slice(route.indexOf(' ') + 1))
  const stats = file === null ? null : stat_file(file)
  if (file === null || stats === null) {
    send_not_found(res, route)
    return
  }

  res.statusCode = 200
  res.setHeader('content-type', CONTENT_TYPES[extname(file)] ?? FALLBACK_CONTENT_TYPE)
  // A localhost dev tool is rebuilt while its tab is open, so nothing it
  // serves may be cached: a stale bundle would look like a broken canvas.
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(stats.size))
  stream_file(res, file)
}

/**
 * Streams a file as the response body, dropping the connection if the read
 * fails.
 *
 * A file can pass `stat_file` and still refuse to open (mode 000 answers
 * EACCES), and a bare `pipe` leaves that stream error unhandled, which ends the
 * process. `pipeline` handles it by destroying both ends, so the client sees a
 * dropped connection and the server keeps serving. It also closes the file when
 * a client leaves mid-stream.
 */
function stream_file(res: ServerResponse, path: string): void {
  pipeline(createReadStream(path), res, () => {
    // Both streams are already destroyed on failure; nothing is left to undo.
  })
}

/**
 * Handles `GET /api/events` by turning the connection into an SSE stream.
 *
 * Replays whatever the client missed since its cursor, subscribes it to the
 * broadcaster for new events, and keeps the connection alive with a periodic
 * heartbeat comment. The cursor is the furthest the client can name: the
 * `Last-Event-ID` a reconnecting browser sends, or the `?since=` a fresh load
 * sets after folding `/api/trajectory`, because native `EventSource` cannot set
 * the header on a first connect. That same cursor guards the live subscription,
 * so an event the history dump already carried is never delivered twice when
 * the file ran ahead of the broadcaster at dump time.
 */
function handle_sse(req: IncomingMessage, res: ServerResponse, broadcaster: Broadcaster): void {
  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('connection', 'keep-alive')
  // Disables response buffering in nginx so SSE frames reach the client as
  // soon as they are written instead of sitting in a proxy buffer.
  res.setHeader('x-accel-buffering', 'no')

  // Node holds the response head back until something is written, so a stream
  // that opens on an empty ring buffer would sit headerless until the first
  // heartbeat 15 seconds later, and `EventSource` would not raise `open` until
  // then. One comment frame flushes the head immediately and is ignored by
  // every SSE client.
  res.write(': connected\n\n')

  // Replay everything after the client's cursor before subscribing. Both
  // calls run synchronously back to back, so there is no window in which
  // an event could land between the replay and the live subscription.
  const cursor = Math.max(
    parse_last_event_id(req.headers['last-event-id']),
    parse_since(req.url),
  )
  for (const entry of broadcaster.snapshot_after(cursor)) {
    write_event(res, entry.id, entry.event)
  }

  // Comment frames keep the connection alive through idle proxies and
  // load balancers that would otherwise time out a quiet SSE stream.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, SSE_HEARTBEAT_MS)

  // The live guard matters only when the cursor sits ahead of the ring: a fresh
  // load that folded a file the broadcaster had not caught up to. In the common
  // reconnect case every live id is already past the cursor, so nothing drops.
  const unsubscribe = broadcaster.subscribe((entry) => {
    if (entry.id > cursor) write_event(res, entry.id, entry.event)
  })

  const close = (): void => {
    clearInterval(heartbeat)
    unsubscribe()
    if (!res.writableEnded) {
      res.write('event: close\ndata: {}\n\n')
      res.end()
    }
  }

  // A clean disconnect and a socket error both need the same cleanup.
  req.on('close', close)
  req.on('error', close)
}

/**
 * Parses the `Last-Event-ID` header into a replay cursor, defaulting to 0.
 *
 * Treats a missing header or a non-numeric or non-positive value as "no
 * cursor", which makes `handle_sse` replay the full ring buffer.
 */
function parse_last_event_id(value: string | string[] | undefined): number {
  if (typeof value !== 'string') return 0
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Parses the `?since=` cursor off a request URL, defaulting to 0.
 *
 * A fresh load sets it after folding `/api/trajectory`, since native
 * `EventSource` cannot send a `Last-Event-ID` header on a first connect. The
 * value reuses `parse_last_event_id`'s number rule, so a missing, absent, or
 * unusable `since` reads as "no cursor" exactly as the header does.
 */
function parse_since(url: string | undefined): number {
  if (typeof url !== 'string') return 0
  const query = url.indexOf('?')
  if (query === -1) return 0
  return parse_last_event_id(new URLSearchParams(url.slice(query + 1)).get('since') ?? undefined)
}

/**
 * Writes one SSE `trajectory` event frame to the response stream.
 */
function write_event(res: ServerResponse, id: number, event: ParsedTrajectoryEvent): void {
  res.write(`id: ${id}\nevent: trajectory\ndata: ${JSON.stringify(event)}\n\n`)
}

/**
 * Whether a `content-type` header names NDJSON, whatever its case and its
 * parameters, so `application/x-ndjson; charset=utf-8` counts.
 */
function is_ndjson(header: string | undefined): boolean {
  if (header === undefined) return false
  const semicolon = header.indexOf(';')
  const type = semicolon === -1 ? header : header.slice(0, semicolon)
  return type.trim().toLowerCase() === NDJSON
}

/**
 * Writes the 413 for an ingest body past the limit, closing the connection so
 * the rest of the body is never read.
 */
function send_too_large(res: ServerResponse): void {
  res.setHeader('connection', 'close')
  send_json(res, 413, {
    error: 'payload_too_large',
    message: `an ingest body holds at most ${INGEST_LIMIT_BYTES} bytes; post the events in smaller batches`,
  })
}

/**
 * Answers an ingest request that won't be read, before any of its body is:
 * a 415 for a body that isn't NDJSON, and a 413 for one whose declared length
 * runs past the limit. Returns whether it answered.
 *
 * Requiring the content type is what keeps a web page out: a page can post a
 * `text/plain` body to any origin without a preflight, but not an NDJSON one.
 */
function refuse_ingest(req: IncomingMessage, res: ServerResponse): boolean {
  if (!is_ndjson(req.headers['content-type'])) {
    send_json(res, 415, {
      error: 'unsupported_media_type',
      message: `post trajectory events as ${NDJSON}, one JSON event to a line`,
    })
    return true
  }
  if (Number(req.headers['content-length']) > INGEST_LIMIT_BYTES) {
    send_too_large(res)
    return true
  }
  return false
}

/**
 * Handles `POST /api/ingest`: parses newline-delimited trajectory events
 * from the request body and feeds valid ones into the broadcaster.
 *
 * Reports how many lines were accepted vs rejected in the response body;
 * a malformed line is skipped and reported via `on_parse_error`, not
 * treated as a fatal request error. A body sent without a length is counted
 * as it streams, and one that runs past the limit gets its 413 there, after
 * the lines before that point have gone out. Once a request is answered,
 * nothing more it sends is read or reported.
 */
function handle_ingest(
  req: IncomingMessage,
  res: ServerResponse,
  broadcaster: Broadcaster,
  on_parse_error?: (err: unknown, line: string) => void,
): void {
  if (refuse_ingest(req, res)) return
  let buf = ''
  let received = 0
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
    const result = parse_trajectory_event(parsed)
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
    if (res.writableEnded) return
    received += Buffer.byteLength(chunk)
    if (received > INGEST_LIMIT_BYTES) {
      send_too_large(res)
      return
    }
    buf += chunk
    // Consume every complete line in the buffer so far; a trailing partial
    // line (no `\n` yet) stays in `buf` until a later chunk completes it.
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      consume_line(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
    }
  })
  req.on('end', () => {
    if (res.writableEnded) return
    // Flush a final line that arrived without a trailing newline.
    if (buf.length > 0) consume_line(buf)
    send_json(res, 200, { accepted, rejected })
  })
  req.on('error', (err: unknown) => {
    if (res.writableEnded) return
    if (on_parse_error) on_parse_error(err, '')
    send_json(res, 400, { error: 'bad_request' })
  })
}

export const internals_for_test = {
  SSE_HEARTBEAT_MS,
  CURSOR_HEADER,
  INGEST_LIMIT_BYTES,
  host_allowed,
  app_dir_candidates,
  resolve_app_dir,
  resolve_app_file,
  parse_last_event_id,
  parse_since,
  serve_trajectory,
  handle_sse,
  handle_ingest,
}
