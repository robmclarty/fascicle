/**
 * Public surface for @repo/observability.
 *
 * Re-exports adapter factories that conform to `TrajectoryLogger` from
 * `@repo/core`. Adapters are injected into the composition layer
 * exclusively through `RunContext` — this package never imports runtime
 * values from core (only types).
 */

export { noop_logger } from './noop.js'
export { filesystem_logger } from './filesystem.js'
export type { FilesystemLoggerOptions } from './filesystem.js'
export { http_logger } from './http.js'
export type { HttpLoggerFetch, HttpLoggerOptions } from './http.js'
export { tee_logger } from './tee.js'
