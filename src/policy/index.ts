/**
 * Public surface for policy.
 *
 * The retry backoff algebra, shared by the composition layer and the engine.
 * Internal to the package: `#policy` has no published subpath, because it is a
 * seam between two layers rather than a surface users compose against.
 */

export { compute_backoff, wait_with_abort } from './backoff.js'
export type { AbortErrorFactory, BackoffPolicy } from './backoff.js'
