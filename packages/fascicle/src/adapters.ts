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

export { filesystem_logger, http_logger, noop_logger, tee_logger } from '@repo/observability'
export type { FilesystemLoggerOptions, HttpLoggerFetch, HttpLoggerOptions } from '@repo/observability'

export { filesystem_store } from '@repo/stores'
export type { FilesystemStoreOptions } from '@repo/stores'
