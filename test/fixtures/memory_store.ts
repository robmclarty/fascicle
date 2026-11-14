import { memory_store as adapter_memory_store } from '../../src/adapters/memory_store.js'
import type { MemoryStoreOptions } from '../../src/adapters/memory_store.js'

export type MemoryStore = ReturnType<typeof adapter_memory_store>

// The store lives in `fascicle/adapters`. The tests inside `src/core` and
// `src/testing` build one through this fixture, because neither module may
// import `adapters`, and a fixture sits outside every module boundary. Every
// other test imports the adapter itself.
export function memory_store(options: MemoryStoreOptions = {}): MemoryStore {
  return adapter_memory_store(options)
}
