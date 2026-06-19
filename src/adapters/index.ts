/**
 * Adapter subpath for fascicle.
 *
 * Re-exports the trajectory logger and checkpoint store adapters that ship
 * with fascicle. Adapters are the swappable I/O layer of a run — the
 * `TrajectoryLogger` and `CheckpointStore` contracts they conform to live at
 * the root of `fascicle`, so users can replace any of these with their own
 * implementation without touching the rest of the public surface.
 *
 * Limits to be aware of:
 * - `filesystem_logger` uses synchronous `appendFileSync` on every event. It
 *   is intended for dev tools and short-lived runs; pair with a different
 *   sink for hot-path production logging.
 * - `filesystem_logger` and `http_logger` use the `parent_span_id` the runner
 *   threads through `RunContext`, so span trees are correct even for concurrent
 *   children under `parallel`/`map`. The in-memory open-span stack is only a
 *   fallback for spans emitted without a parent (e.g. an external caller using
 *   a logger directly), and that fallback remains best-effort under concurrency.
 */

export { filesystem_logger } from './filesystem_logger.js'
export type { FilesystemLoggerOptions } from './filesystem_logger.js'
export { http_logger } from './http_logger.js'
export type { HttpLoggerFetch, HttpLoggerOptions } from './http_logger.js'
export { noop_logger } from './noop_logger.js'
export { tee_logger } from './tee_logger.js'

export { filesystem_store } from './filesystem_store.js'
export type { FilesystemStoreOptions } from './filesystem_store.js'
