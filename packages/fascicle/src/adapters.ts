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
 * - The span stacks inside `filesystem_logger` and `http_logger` are
 *   in-memory and not async-context-aware. Two siblings spawned concurrently
 *   from the same parent will record whichever opened most recently as their
 *   parent until proper async-context propagation lands.
 */

export { filesystem_logger, http_logger, noop_logger, tee_logger } from '@repo/observability'
export type { FilesystemLoggerOptions, HttpLoggerFetch, HttpLoggerOptions } from '@repo/observability'

export { filesystem_store } from '@repo/stores'
export type { FilesystemStoreOptions } from '@repo/stores'
