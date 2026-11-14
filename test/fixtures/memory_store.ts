// The store lives in `fascicle/adapters`. The tests inside `src/core` and
// `src/testing` reach it here, because neither module may import `adapters`,
// and a fixture sits outside every module boundary.
export { memory_store } from '../../src/adapters/memory_store.js'
export type { MemoryStore } from '../../src/adapters/memory_store.js'
