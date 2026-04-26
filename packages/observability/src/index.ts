/**
 * Public surface for @repo/observability.
 *
 * Re-exports adapter factories that conform to `TrajectoryLogger` from
 * `@repo/core`. Adapters are injected into the composition layer
 * exclusively through `RunContext` — this package never imports runtime
 * values from core (only types).
 */

export { noop_logger } from './noop.js';
export { filesystem_logger } from './filesystem.js';
export type { FilesystemLoggerOptions } from './filesystem.js';
