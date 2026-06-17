/**
 * Public surface for @repo/viewer.
 *
 * `start_viewer({ ... })` is the programmatic embed: spin up the server,
 * optionally start tailing a JSONL file, and return a handle that can stop
 * both. `start_viewer` only depends on @repo/core's wire-format schema; it
 * never reaches into the engine, composites, or any provider.
 */

import { create_broadcaster } from './broadcast.js'
import { start_server, type ViewerServer } from './server.js'
import { start_tail, type Tail } from './tail.js'

export type StartViewerOptions = {
  readonly path?: string
  readonly host?: string
  readonly port?: number
  readonly buffer?: number
  readonly on_parse_error?: (err: unknown, line: string) => void
  readonly on_io_error?: (err: unknown) => void
  readonly on_subscriber_error?: (err: unknown) => void
}

export type ViewerHandle = {
  readonly url: string
  readonly host: string
  readonly port: number
  readonly close: () => Promise<void>
}

export async function start_viewer(options: StartViewerOptions = {}): Promise<ViewerHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 4242
  const buffer = options.buffer ?? 1000
  const broadcaster = create_broadcaster({
    buffer,
    ...(options.on_subscriber_error ? { on_subscriber_error: options.on_subscriber_error } : {}),
  })
  const server = await start_server({
    broadcaster,
    host,
    port,
    ...(options.on_parse_error ? { on_parse_error: options.on_parse_error } : {}),
  })

  let tail: Tail | null = null
  if (options.path !== undefined) {
    tail = start_tail({
      path: options.path,
      on_event: (event) => { broadcaster.emit(event) },
      ...(options.on_parse_error ? { on_parse_error: options.on_parse_error } : {}),
      ...(options.on_io_error ? { on_io_error: options.on_io_error } : {}),
    })
  }

  return wrap_handle(server, tail, host, port)
}

function wrap_handle(
  server: ViewerServer,
  tail: Tail | null,
  host: string,
  port: number,
): ViewerHandle {
  return {
    url: server.url,
    host,
    port,
    close: async () => {
      if (tail) tail.stop()
      await server.close()
    },
  }
}

export { create_broadcaster } from './broadcast.js'
export type { Broadcaster, BroadcasterOptions, BroadcastEvent, Subscriber } from './broadcast.js'
export { start_server } from './server.js'
export type { ServerOptions, ViewerServer } from './server.js'
export { start_tail } from './tail.js'
export type { Tail, TailOptions } from './tail.js'
export { run_viewer_cli } from './cli.js'
