/**
 * Public surface for @repo/stores.
 *
 * Re-exports adapter factories that conform to `CheckpointStore` from
 * `@repo/core`. Adapters are injected into the composition layer
 * exclusively through `RunContext` — this package never imports runtime
 * values from core (only types).
 */

export { filesystem_store } from './filesystem.js'
export type { FilesystemStoreOptions } from './filesystem.js'
