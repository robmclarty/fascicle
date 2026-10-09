type ClaimRecord = { owner: string; expires_at: number }

type Space = {
  readonly path: ReadonlyArray<string>
  readonly values: Map<string, unknown>
  readonly claims: Map<string, ClaimRecord>
}

type MemoryStoreOptions = {
  // The clock claims expire against. A suite that moves time replaces it.
  readonly now?: () => number
}

type MemoryScope = {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
  readonly delete: (key: string) => Promise<void>
  readonly scope: (prefix: string) => MemoryScope
  readonly clear: () => Promise<void>
  readonly claim: (key: string, owner: string, ttl_ms: number) => Promise<boolean>
  readonly release: (key: string, owner: string) => Promise<void>
}

export type MemoryStore = Omit<MemoryScope, 'clear'> & {
  // Every value, by scope path and key, for a suite that asserts on what the
  // store holds. The path is the JSON of the prefixes that led to the scope.
  readonly dump: () => Record<string, Record<string, unknown>>
}

// An in-memory CheckpointStore with every optional capability, so a suite can
// drive scopes and claims without touching disk. Every scope lives in one map
// keyed by the path of prefixes that reached it, so reopening a scope finds
// its data and `clear` drops a whole subtree. Values are cloned in and out,
// the way a store that serializes would hand back a copy.
export function memory_store(options: MemoryStoreOptions = {}): MemoryStore {
  const now = options.now ?? (() => Date.now())
  const spaces = new Map<string, Space>()

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

  const store_at = (path: ReadonlyArray<string>): Omit<MemoryScope, 'clear'> => ({
    get: async (key) => {
      const value = space_at(path).values.get(key)
      return value === undefined ? null : structuredClone(value)
    },
    set: async (key, value) => {
      space_at(path).values.set(key, structuredClone(value))
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
  })

  const dump = (): Record<string, Record<string, unknown>> => {
    const out: Record<string, Record<string, unknown>> = {}
    for (const [id, space] of spaces) {
      if (space.values.size > 0) out[id] = Object.fromEntries(space.values)
    }
    return out
  }

  return { ...store_at([]), dump }
}
