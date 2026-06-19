/**
 * Public surface for viewer.
 *
 * `start_viewer({ ... })` (in `./start_viewer.ts`) is the programmatic embed:
 * spin up the server, optionally start tailing a JSONL file, and return a
 * handle that can stop both. `start_viewer` only depends on core's wire-format
 * schema; it never reaches into the engine, composites, or any provider.
 */

export { start_viewer } from './start_viewer.js'
export type { StartViewerOptions, ViewerHandle } from './start_viewer.js'
export { create_broadcaster } from './broadcast.js'
export type { Broadcaster, BroadcasterOptions, BroadcastEvent, Subscriber } from './broadcast.js'
export { start_server } from './server.js'
export type { ServerOptions, ViewerServer } from './server.js'
export { start_tail } from './tail.js'
export type { Tail, TailOptions } from './tail.js'
export { run_viewer_cli } from './cli.js'
