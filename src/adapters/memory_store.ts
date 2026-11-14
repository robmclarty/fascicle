/**
 * In-memory checkpoint store.
 *
 * Satisfies `CheckpointStore` from `core`, every optional capability
 * included, so `durable` can keep its runs in one without touching disk. It
 * lasts as long as the value does, which suits a test, a demo, and a server
 * whose runs may end with the process.
 *
 * Every scope lives in one map keyed by the path of prefixes that reached
 * it, so reopening a scope finds its data and `clear` drops a whole subtree.
 * Values are cloned on the way in and on the way out, the way a store that
 * serializes hands back a copy, so a caller can't change what the store
 * holds by changing what it was given. A version is a count of the store's
 * writes, so no two writes share one, in any scope, unless
 * `content_versions` asks for the value's JSON instead.
 */

import type { CheckpointStore, Versioned } from '#core'

type ClaimRecord = { owner: string; expires_at: number }

type Entry = { readonly value: unknown; readonly version: string }

type Space = {
  readonly path: ReadonlyArray<string>
  readonly values: Map<string, Entry>
  readonly claims: Map<string, ClaimRecord>
}

export type MemoryStoreOptions = {
  /** The clock claims expire against, which a test that moves time replaces; default: `Date.now`. */
  readonly now?: (() => number) | undefined
  /**
   * Derive a value's version from its content, the way a store that hashes
   * the bytes or reads an ETag does, so two writes of one value share a
   * version; default: false.
   */
  readonly content_versions?: boolean | undefined
}

/**
 * A scope of a `memory_store`, which can also `clear`.
 */
export type MemoryScopedStore = Required<Omit<CheckpointStore, 'scope'>> & {
  readonly scope: (prefix: string) => MemoryScopedStore
  readonly clear: () => Promise<void>
}

/**
 * What `memory_store` returns: a `CheckpointStore` with every optional
 * capability, plus `dump`.
 */
export type MemoryStore = Omit<MemoryScopedStore, 'clear'> & {
  /**
   * Every value the store holds, by scope path and then by key, for a test
   * that asserts on what was kept. A scope's path is the JSON of the
   * prefixes that led to it, so the root is `'[]'`.
   */
  readonly dump: () => Record<string, Record<string, unknown>>
}

/**
 * Build an in-memory `CheckpointStore` with scopes, claims, and conditional
 * writes.
 */
export function memory_store(options: MemoryStoreOptions = {}): MemoryStore {
  const now = options.now ?? (() => Date.now())
  const spaces = new Map<string, Space>()
  let writes = 0

  const space_at = (path: ReadonlyArray<string>): Space => {
    const id = JSON.stringify(path)
    const existing = spaces.get(id)
    if (existing !== undefined) return existing
    const created: Space = { path, values: new Map(), claims: new Map() }
    spaces.set(id, created)
    return created
  }

  const clear_under = (path: ReadonlyArray<string>): void => {
    for (const [id, space] of spaces) {
      if (path.every((part, i) => space.path[i] === part)) spaces.delete(id)
    }
  }

  const write = (path: ReadonlyArray<string>, key: string, value: unknown): void => {
    writes += 1
    const version = options.content_versions === true ? JSON.stringify(value) : `w${writes}`
    space_at(path).values.set(key, { value: structuredClone(value), version })
  }

  const store_at = (path: ReadonlyArray<string>): Omit<MemoryScopedStore, 'clear'> => ({
    get: async (key) => {
      const value = space_at(path).values.get(key)?.value
      return value === undefined ? null : structuredClone(value)
    },
    set: async (key, value) => {
      write(path, key, value)
    },
    delete: async (key) => {
      space_at(path).values.delete(key)
    },
    scope: (prefix) => {
      const inner = [...path, prefix]
      return { ...store_at(inner), clear: async () => clear_under(inner) }
    },
    claim: async (key, owner, ttl_ms) => {
      const claims = space_at(path).claims
      const current = claims.get(key)
      const at = now()
      if (current !== undefined && current.expires_at > at && current.owner !== owner) return false
      claims.set(key, { owner, expires_at: at + ttl_ms })
      return true
    },
    release: async (key, owner) => {
      const claims = space_at(path).claims
      if (claims.get(key)?.owner === owner) claims.delete(key)
    },
    get_versioned: async (key): Promise<Versioned | undefined> => {
      const entry = space_at(path).values.get(key)
      if (entry === undefined) return undefined
      const value = entry.value === null ? undefined : structuredClone(entry.value)
      return { value, version: entry.version }
    },
    set_if: async (key, value, expected) => {
      const version = space_at(path).values.get(key)?.version ?? null
      if (version !== expected) return false
      write(path, key, value)
      return true
    },
  })

  const dump = (): Record<string, Record<string, unknown>> => {
    const out: Record<string, Record<string, unknown>> = {}
    for (const [id, space] of spaces) {
      if (space.values.size === 0) continue
      out[id] = Object.fromEntries([...space.values].map(([key, entry]) => [key, entry.value]))
    }
    return out
  }

  return { ...store_at([]), dump }
}
