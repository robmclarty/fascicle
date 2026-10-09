import { describe, expect, it, vi } from 'vitest'
import type { CheckpointStore, ScopedCheckpointStore } from '#core'
import { memory_store, type MemoryStore } from '../../../test/fixtures/memory_store.js'
import {
  checkpoint_store_conformance,
  type StoreConformanceOptions,
} from '../checkpoint_store_conformance.js'

const CONTRACT = [
  'a missing key reads as a miss',
  'values round-trip as JSON',
  'set overwrites a value',
  'delete removes a value',
  'deleting a missing key resolves',
  'a stored null or undefined reads as a miss',
  'keys that encode alike stay apart',
  'racing writes leave one whole value',
]
const DAMAGE = ['a damaged value reads as a miss']
const SCOPE = [
  'a scope is apart from its parent',
  'one prefix reaches the same data, another prefix does not',
  'prefixes that encode alike stay apart',
  'nested scopes stay apart from look-alike prefixes',
  'clear empties a scope and nothing else',
  'clearing an empty scope resolves',
]
const CLAIM = [
  'claim comes with release',
  'a free key can be claimed',
  'a held key refuses another owner',
  'the owner can renew its claim',
  'release lets another owner in',
  'release by another owner changes nothing',
  'releasing a key nobody holds resolves',
  'claims and values stay apart',
  'different keys are claimed apart',
  'exactly one racing claimer wins a free key',
  'an expired claim passes to another owner',
  'exactly one racing claimer takes an expired claim',
  'renewing restarts the clock',
]
const SCOPED_CLAIM = [
  'scopes keep the claim capability',
  'claims in different scopes stay apart',
  'clear drops the claims under a scope',
]

// Short enough that the expiry checks wait tens of milliseconds, not seconds.
const FAST: StoreConformanceOptions = { ttl_ms: 20 }

type Patch = (base: MemoryStore) => Partial<CheckpointStore>

// A fresh memory store per call with `patch` laid over it, so each test
// breaks the contract in exactly the way it names.
function broken(patch: Patch): () => CheckpointStore {
  return () => {
    const base = memory_store()
    return { ...base, ...patch(base) }
  }
}

// The failed checks of one suite run, by check name.
async function failures_of(
  make_store: () => CheckpointStore,
  options: StoreConformanceOptions = {},
): Promise<Record<string, string>> {
  const report = await checkpoint_store_conformance(make_store, { ...FAST, ...options })
  return Object.fromEntries(report.failed.map((failure) => [failure.check, failure.message]))
}

// A scope over its own values that shares claims with nothing, built from
// plain maps so a test can wire one capability wrong.
function plain_scope(values = new Map<string, unknown>()): ScopedCheckpointStore {
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => {
      values.delete(key)
    },
    scope: () => plain_scope(),
    clear: async () => {
      values.clear()
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// A memory store without the scope capability.
function scopeless(): CheckpointStore {
  const { get, set, delete: remove, claim, release } = memory_store()
  return { get, set, delete: remove, claim, release }
}

// Lowercase a key and turn every separator into `_`, the way a naive encoder
// would before using the key as a file name.
const naive_encode = (key: string): string => key.replace(/[^a-z0-9]/gi, '_').toLowerCase()

// Rewrite every key on its way into the store, the way a store that encodes
// keys for its backend would.
function encoded(encode: (key: string) => string): () => CheckpointStore {
  return broken((base) => ({
    get: (key) => base.get(encode(key)),
    set: (key, value) => base.set(encode(key), value),
    delete: (key) => base.delete(encode(key)),
  }))
}

// Turn every non-ASCII run into one question mark, the way a store that
// writes text in a single-byte encoding would.
const ascii_only = (text: string): string => text.replace(/[\u0080-\u{10ffff}]+/gu, '?')

// Rebuild every object with its keys in reverse order, the way a backend that
// stores JSON by its own rules (Postgres jsonb) hands it back.
const reversed = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).toReversed().map(([k, v]) => [k, reversed(v)]))
    : value

// Cut a long `body` short, the way a write torn by a crash would land.
const tear = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'body' in value
    ? { ...value, body: String(value.body).slice(0, 100) }
    : value

describe('checkpoint_store_conformance', () => {
  it('passes every check, in order, for a store that keeps the whole contract', async () => {
    const report = await checkpoint_store_conformance(() => memory_store(), {
      ...FAST,
      corrupt: (store, key) => store.set(key, null),
    })
    expect(report.failed).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.passed).toEqual([...CONTRACT, ...DAMAGE, ...SCOPE, ...CLAIM, ...SCOPED_CLAIM])
  })

  it('calls claim and release on the store, so methods that use `this` work', async () => {
    type Holder = { readonly base: MemoryStore }
    const report = await checkpoint_store_conformance(() => {
      const base = memory_store()
      const store = {
        base,
        get: base.get,
        set: base.set,
        delete: base.delete,
        claim(this: Holder, key: string, owner: string, ttl_ms: number) {
          return this.base.claim(key, owner, ttl_ms)
        },
        release(this: Holder, key: string, owner: string) {
          return this.base.release(key, owner)
        },
      }
      return store
    }, FAST)
    expect(report.failed).toEqual([])
  })

  it('skips the damage, scope, and claim checks a bare store has no part in', async () => {
    const report = await checkpoint_store_conformance(() => {
      const { get, set, delete: remove } = memory_store()
      return { get, set, delete: remove }
    }, FAST)
    expect(report.failed).toEqual([])
    expect(report.passed).toEqual(CONTRACT)
    expect(report.skipped).toEqual([...DAMAGE, ...SCOPE, ...CLAIM, ...SCOPED_CLAIM])
  })

  it('runs the claim checks for a store with claims and no scope, and skips the scoped ones', async () => {
    const report = await checkpoint_store_conformance(scopeless, FAST)
    expect(report.failed).toEqual([])
    expect(report.skipped).toEqual([...DAMAGE, ...SCOPE, ...SCOPED_CLAIM])
  })

  it('waits 200ms on an expiry check when no ttl_ms is given', async () => {
    const started = Date.now()
    await checkpoint_store_conformance(scopeless)
    // Two expiry checks wait twice the ttl and a third waits a little over it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
  })

  describe('the core contract', () => {
    it('fails a store that hands back an empty string for a miss', async () => {
      const failures = await failures_of(
        broken((base) => ({ get: async (key) => (await base.get(key)) ?? '' })),
      )
      expect(failures).toMatchObject({
        'a missing key reads as a miss': 'get on a key nobody set returned ""',
        'delete removes a value': 'get after delete returned ""',
        'a stored null or undefined reads as a miss': 'a stored null read back as a hit',
        'claims and values stay apart': 'claiming a key gave it a value',
      })
    })

    it('fails a store that stores undefined as a value', async () => {
      const failures = await failures_of(
        broken((base) => ({
          set: (key, value) => base.set(key, value === undefined ? 'undefined' : value),
        })),
      )
      expect(failures).toEqual({
        'a stored null or undefined reads as a miss': 'a stored undefined read back as a hit',
      })
    })

    it('fails a store that loses a falsy value', async () => {
      const failures = await failures_of(
        broken((base) => ({ set: (key, value) => base.set(key, value === false ? null : value) })),
      )
      expect(failures).toEqual({ 'values round-trip as JSON': 'set false and got back null' })
    })

    it('fails a store that loses a value it was handed', async () => {
      const failures = await failures_of(
        broken((base) => ({
          get: async (key) => (key === 'sample-0' ? undefined : base.get(key)),
        })),
      )
      expect(failures).toEqual({
        'values round-trip as JSON':
          'set {"candidate":"a","converged":true,"rounds":2} and got back undefined',
      })
    })

    it('fails a store where the first write wins', async () => {
      const failures = await failures_of(
        broken((base) => ({
          set: async (key, value) => {
            if ((await base.get(key)) === null) await base.set(key, value)
          },
        })),
      )
      expect(failures).toEqual({ 'set overwrites a value': 'a second set lost to the first: {"v":1}' })
    })

    it('fails a store whose delete keeps the value', async () => {
      const failures = await failures_of(broken(() => ({ delete: async () => {} })))
      expect(failures).toEqual({ 'delete removes a value': 'get after delete returned {"v":1}' })
    })

    it('fails a store that throws deleting a key it never had', async () => {
      const failures = await failures_of(
        broken((base) => ({
          delete: async (key) => {
            if ((await base.get(key)) === null) throw new Error(`nothing at ${key}`)
            await base.delete(key)
          },
        })),
      )
      expect(failures).toEqual({ 'deleting a missing key resolves': 'nothing at never-set' })
    })

    it('fails a store that merges keys which slug alike', async () => {
      const failures = await failures_of(
        broken((base) => ({
          get: (key) => base.get(naive_encode(key)),
          set: (key, value) => base.set(naive_encode(key), value),
          delete: (key) => base.delete(naive_encode(key)),
        })),
      )
      expect(failures).toEqual({
        'keys that encode alike stay apart': 'key "a/b" read back 4, another key\'s value',
      })
    })

    it('fails a store that tears a large write', async () => {
      const failures = await failures_of(
        broken((base) => ({ set: (key, value) => base.set(key, tear(value)) })),
      )
      const torn = JSON.stringify({ writer: 7, body: 'x'.repeat(100) })
      expect(failures).toEqual({
        'racing writes leave one whole value': `after 8 racing sets, get returned ${torn.slice(0, 77)}..., which none of them wrote`,
      })
    })

    it('passes a store that reports a miss as undefined', async () => {
      const report = await checkpoint_store_conformance(
        broken((base) => ({ get: async (key) => (await base.get(key)) ?? undefined })),
        FAST,
      )
      expect(report.failed).toEqual([])
    })

    it('passes a store that hands objects back with their keys in another order', async () => {
      const report = await checkpoint_store_conformance(
        broken((base) => ({ get: async (key) => reversed(await base.get(key)) })),
        FAST,
      )
      expect(report.failed).toEqual([])
    })

    it('fails a store that hands an array back as an object', async () => {
      const failures = await failures_of(
        broken((base) => ({
          get: async (key) => {
            const value = await base.get(key)
            return Array.isArray(value) ? Object.fromEntries(value.entries()) : value
          },
        })),
      )
      expect(failures).toEqual({ 'values round-trip as JSON': 'set [1,2,3] and got back {"0":1,"1":2,"2":3}' })
    })

    it('fails a store that loses an empty string, or an empty array', async () => {
      const empty_string = await failures_of(
        broken((base) => ({ set: (key, value) => base.set(key, value === '' ? null : value) })),
      )
      expect(empty_string).toEqual({ 'values round-trip as JSON': 'set "" and got back null' })
      const empty_array = await failures_of(
        broken((base) => ({
          set: (key, value) => base.set(key, Array.isArray(value) && value.length === 0 ? null : value),
        })),
      )
      expect(empty_array).toEqual({ 'values round-trip as JSON': 'set [] and got back null' })
    })

    it('fails a store that writes text in a single-byte encoding', async () => {
      const failures = await failures_of(
        broken((base) => ({
          set: (key, value) => base.set(key, typeof value === 'string' ? ascii_only(value) : value),
        })),
      )
      const sample = 'unicode: naïve café, 世界, 🔑'
      expect(failures).toEqual({
        'values round-trip as JSON': `set ${JSON.stringify(sample)} and got back ${JSON.stringify(ascii_only(sample))}`,
      })
    })

    it('fails a store that stores null as a hit', async () => {
      const failures = await failures_of(
        broken((base) => ({ set: (key, value) => base.set(key, value === null ? 'null' : value) })),
      )
      expect(failures).toEqual({
        'a stored null or undefined reads as a miss': 'a stored null read back as a hit',
      })
    })

    it('shows a value of exactly eighty characters in full', async () => {
      const value = 'x'.repeat(78)
      const failures = await failures_of(
        broken((base) => ({ get: async (key) => (key === 'never-set' ? value : base.get(key)) })),
      )
      expect(failures['a missing key reads as a miss']).toBe(
        `get on a key nobody set returned ${JSON.stringify(value)}`,
      )
    })

    it.each([
      ['turns slashes into underscores', (key: string) => key.replaceAll('/', '_'), 'key "a/b" read back 1'],
      ['turns colons into underscores', (key: string) => key.replaceAll(':', '_'), 'key "a_b" read back 2'],
      ['turns spaces into underscores', (key: string) => key.replaceAll(' ', '_'), 'key "a_b" read back 3'],
      ['drops a trailing slash', (key: string) => key.replace(/\/+$/, ''), 'key "a/b" read back 5'],
      ['writes keys in a single-byte encoding', ascii_only, 'key "鍵" read back 10'],
      [
        'cuts keys to a hundred characters',
        (key: string) => key.slice(0, 100),
        `key "${'k'.repeat(76)}... read back 12`,
      ],
    ])('fails a store that %s', async (_, encode, start) => {
      const failures = await failures_of(encoded(encode))
      expect(failures).toEqual({ 'keys that encode alike stay apart': `${start}, another key's value` })
    })

    it('fails a check whose store rejects with something other than an Error', async () => {
      const failures = await failures_of(
        broken(() => ({ get: () => Promise.reject(new Map([['reason', 'opaque']])) })),
      )
      expect(failures['a missing key reads as a miss']).toBe('[object Map]')
    })

    it('fails every check when make_store throws after the first store', async () => {
      let calls = 0
      const report = await checkpoint_store_conformance(() => {
        calls += 1
        if (calls > 1) throw new Error('the backing service is down')
        return memory_store()
      }, FAST)
      expect(report.passed).toEqual([])
      expect(report.failed).toHaveLength(CONTRACT.length + SCOPE.length + CLAIM.length + SCOPED_CLAIM.length)
      expect(new Set(report.failed.map((failure) => failure.message))).toEqual(
        new Set(['the backing service is down']),
      )
    })
  })

  describe('damaged values', () => {
    it('fails a store that throws reading a damaged value', async () => {
      const damaged = new Set<string>()
      const failures = await failures_of(
        broken((base) => ({
          get: async (key) => {
            if (damaged.has(key)) throw new Error('unreadable')
            return base.get(key)
          },
        })),
        { corrupt: (_, key) => void damaged.add(key) },
      )
      expect(failures).toEqual({
        'a damaged value reads as a miss':
          'get threw on a damaged value instead of missing: Error: unreadable',
      })
    })

    it('fails a store that hands back a damaged value as a hit', async () => {
      const damaged = new Set<string>()
      const failures = await failures_of(
        broken((base) => ({
          get: async (key) => (damaged.has(key) ? '{ not json' : base.get(key)),
        })),
        { corrupt: (_, key) => void damaged.add(key) },
      )
      expect(failures).toEqual({
        'a damaged value reads as a miss': 'get on a damaged value returned "{ not json"',
      })
    })
  })

  describe('scopes', () => {
    it('fails a store whose scopes all share the parent', async () => {
      const failures = await failures_of(
        broken((base) => ({
          scope: () => ({ ...base, clear: async () => {} }),
        })),
      )
      expect(failures).toMatchObject({
        'a scope is apart from its parent': "a scope read its parent's value",
        'one prefix reaches the same data, another prefix does not':
          "scope 'b' read a value set in scope 'a'",
        'prefixes that encode alike stay apart': 'scope "a/b" read back 12, another scope\'s',
        'clear empties a scope and nothing else': 'a value survived clear',
        'claims in different scopes stay apart': "scope 'b' couldn't claim a key held in scope 'a'",
        'clear drops the claims under a scope': 'a claim survived clear',
      })
    })

    it('fails a scope whose writes leak into its parent', async () => {
      const failures = await failures_of(
        broken((base) => ({
          scope: (prefix) => {
            const scope = base.scope(prefix)
            return {
              ...scope,
              set: async (key, value) => {
                await scope.set(key, value)
                await base.set(key, value)
              },
            }
          },
        })),
      )
      expect(failures).toMatchObject({
        'a scope is apart from its parent': "a write in a scope changed its parent's value",
      })
    })

    it('fails a scope that drops its own writes', async () => {
      const failures = await failures_of(
        broken((base) => ({ scope: (prefix) => ({ ...base.scope(prefix), set: async () => {} }) })),
      )
      expect(failures).toMatchObject({
        'a scope is apart from its parent': 'a scope lost its own value',
        'clear empties a scope and nothing else': "clear removed a sibling's value",
      })
    })

    it('fails a store that opens a new empty scope every time', async () => {
      const failures = await failures_of(broken(() => ({ scope: () => plain_scope() })))
      expect(failures).toMatchObject({
        'one prefix reaches the same data, another prefix does not': 'reopening a scope lost its value',
        'nested scopes stay apart from look-alike prefixes': 'reopening a nested scope lost its value',
      })
    })

    it('fails a store that ignores the prefix', async () => {
      const failures = await failures_of(
        broken(() => {
          const shared = new Map<string, unknown>()
          return { scope: () => plain_scope(shared) }
        }),
      )
      expect(failures).toMatchObject({
        'one prefix reaches the same data, another prefix does not':
          "scope 'b' read a value set in scope 'a'",
        'clear empties a scope and nothing else': "clear removed a sibling's value",
      })
    })

    it('fails a store that flattens a nested scope into a joined prefix', async () => {
      const failures = await failures_of(
        broken((base) => ({
          scope: (prefix) => ({
            ...base.scope(prefix),
            scope: (inner) => base.scope(`${prefix}/${inner}`),
          }),
        })),
      )
      expect(failures).toMatchObject({
        'nested scopes stay apart from look-alike prefixes':
          "scope \"a/b\" read the value of scope 'b' in scope 'a'",
      })
    })

    it.each([
      ['with nothing between them', '', 'ab'],
      ['with a dot', '.', 'a.b'],
      ['with a colon', ':', 'a:b'],
    ])('fails a store that joins nested prefixes %s', async (_, joiner, flat) => {
      const failures = await failures_of(
        broken((base) => ({
          scope: (prefix) => ({
            ...base.scope(prefix),
            scope: (inner) => base.scope(`${prefix}${joiner}${inner}`),
          }),
        })),
      )
      expect(failures).toMatchObject({
        'nested scopes stay apart from look-alike prefixes': `scope "${flat}" read the value of scope 'b' in scope 'a'`,
      })
    })

    it('fails a store whose nested scope forgets its parent', async () => {
      const failures = await failures_of(
        broken((base) => ({ scope: (prefix) => ({ ...base.scope(prefix), scope: (inner) => base.scope(inner) }) })),
      )
      expect(failures).toMatchObject({
        'nested scopes stay apart from look-alike prefixes': `scope "b" read the value of scope 'b' in scope 'a'`,
      })
    })

    it('fails a store whose nested scope is the scope itself', async () => {
      const failures = await failures_of(
        broken((base) => ({
          scope: (prefix) => {
            const scope = base.scope(prefix)
            return { ...scope, scope: () => scope }
          },
        })),
      )
      expect(failures).toMatchObject({
        'nested scopes stay apart from look-alike prefixes':
          "a nested scope's value showed up in its parent",
      })
    })

    it('fails a clear that leaves nested scopes behind', async () => {
      const failures = await failures_of(
        broken((base) => ({
          scope: (prefix) => {
            const scope = base.scope(prefix)
            const nested = new Map<string, ScopedCheckpointStore>()
            return {
              ...scope,
              scope: (inner) => {
                const opened = nested.get(inner) ?? plain_scope()
                nested.set(inner, opened)
                return opened
              },
              clear: async () => {
                await scope.delete('k')
              },
            }
          },
        })),
      )
      expect(failures).toMatchObject({
        'clear empties a scope and nothing else': "a nested scope's value survived clear",
      })
    })

    it("fails a clear that wipes the parent's values", async () => {
      const failures = await failures_of(
        broken((base) => ({
          scope: (prefix) => {
            const scope = base.scope(prefix)
            return {
              ...scope,
              clear: async () => {
                await scope.clear()
                await base.delete('k')
              },
            }
          },
        })),
      )
      expect(failures).toMatchObject({
        'clear empties a scope and nothing else': "clear removed the parent's value",
      })
    })

    it('fails a scope that refuses new values once cleared', async () => {
      const failures = await failures_of(
        broken((base) => ({
          scope: (prefix) => {
            const scope = base.scope(prefix)
            let cleared = false
            return {
              ...scope,
              set: async (key, value) => {
                if (!cleared) await scope.set(key, value)
              },
              clear: async () => {
                cleared = true
                await scope.clear()
              },
            }
          },
        })),
      )
      expect(failures).toMatchObject({
        'clear empties a scope and nothing else': 'a cleared scope refused a new value',
      })
    })

    it('fails a clear that throws on an empty scope', async () => {
      const failures = await failures_of(
        broken((base) => ({
          scope: (prefix) => ({
            ...base.scope(prefix),
            clear: () => Promise.reject(new Error(`nothing to clear in ${prefix}`)),
          }),
        })),
      )
      expect(failures).toMatchObject({
        'clearing an empty scope resolves': 'nothing to clear in never-used',
      })
    })

    it('fails the scope checks when a later store from make_store has no scope', async () => {
      let calls = 0
      const failures = await failures_of(() => {
        calls += 1
        return calls === 1 ? memory_store() : scopeless()
      })
      for (const check of SCOPE) {
        expect(failures[check]).toBe('make_store returned a store without scope')
      }
    })
  })

  describe('claims', () => {
    it('skips the claim checks for a store that scopes but has no claims', async () => {
      const report = await checkpoint_store_conformance(() => {
        const { get, set, delete: remove, scope } = memory_store()
        return { get, set, delete: remove, scope }
      }, FAST)
      expect(report.failed).toEqual([])
      expect(report.skipped).toEqual([...DAMAGE, ...CLAIM, ...SCOPED_CLAIM])
    })

    it('fails a release that frees a claim for anyone who asks', async () => {
      const failures = await failures_of(
        broken(() => {
          const holders = new Map<string, string>()
          return {
            claim: async (key, owner) => {
              const holder = holders.get(key)
              if (holder !== undefined && holder !== owner) return false
              holders.set(key, owner)
              return true
            },
            release: async (key) => {
              holders.delete(key)
            },
          }
        }),
      )
      expect(failures).toMatchObject({
        'release by another owner changes nothing': "a release by a non-owner freed the owner's claim",
      })
    })

    it('fails a store with claim and no release', async () => {
      const failures = await failures_of(() => {
        const { get, set, delete: remove, scope, claim } = memory_store()
        return { get, set, delete: remove, scope, claim }
      })
      expect(failures['claim comes with release']).toBe('the store offers claim without release')
    })

    it('fails a store with release and no claim', async () => {
      const failures = await failures_of(() => {
        const { get, set, delete: remove, scope, release } = memory_store()
        return { get, set, delete: remove, scope, release }
      })
      expect(failures['claim comes with release']).toBe('the store offers release without claim')
    })

    it('fails a store whose scopes lose the claim capability', async () => {
      const failures = await failures_of(
        broken((base) => ({
          scope: (prefix) => {
            const { get, set, delete: remove, scope, clear } = base.scope(prefix)
            return { get, set, delete: remove, scope, clear }
          },
        })),
      )
      expect(failures['scopes keep the claim capability']).toBe(
        'the store has neither claim nor release',
      )
    })

    it('fails a store that refuses every claim', async () => {
      const failures = await failures_of(
        broken((base) => ({
          claim: async () => false,
          scope: (prefix) => ({ ...base.scope(prefix), claim: async () => false }),
        })),
      )
      expect(failures).toMatchObject({
        'a free key can be claimed': 'a claim on a key nobody holds returned false',
        'different keys are claimed apart': 'a claim on a key nobody holds returned false',
        'scopes keep the claim capability': 'a claim inside a fresh scope returned false',
        'claims in different scopes stay apart': 'a claim inside a fresh scope returned false',
        'clear drops the claims under a scope': 'a claim inside a fresh scope returned false',
        'exactly one racing claimer wins a free key': '8 owners raced for a free key and 0 won',
      })
    })

    it('fails a store that grants every claim', async () => {
      const failures = await failures_of(broken(() => ({ claim: async () => true })))
      expect(failures).toMatchObject({
        'a held key refuses another owner': 'a second owner claimed a key the first still holds',
        'release by another owner changes nothing': "a release by a non-owner freed the owner's claim",
        'claims and values stay apart': 'deleting a value released the claim on the same key',
        'exactly one racing claimer wins a free key': '8 owners raced for a free key and 8 won',
        'an expired claim passes to another owner':
          'the first owner took back a claim that had passed to another',
        'exactly one racing claimer takes an expired claim':
          '8 owners raced for an expired claim and 8 won',
      })
    })

    it('fails a store that refuses a claim on any key already claimed', async () => {
      const failures = await failures_of(
        broken(() => {
          const held = new Set<string>()
          return {
            claim: async (key) => {
              if (held.has(key)) return false
              held.add(key)
              return true
            },
            release: async (key) => {
              held.delete(key)
            },
          }
        }),
      )
      expect(failures).toMatchObject({
        'the owner can renew its claim': 'the owner could not renew its own live claim',
      })
    })

    it('fails a release that does nothing', async () => {
      const failures = await failures_of(broken(() => ({ release: async () => {} })))
      expect(failures).toMatchObject({
        'release lets another owner in': 'a released key refused the next owner',
      })
    })

    it('fails a release that throws for a key nobody holds', async () => {
      const failures = await failures_of(
        broken(() => ({ release: (key) => Promise.reject(new Error(`no claim on ${key}`)) })),
      )
      expect(failures).toMatchObject({
        'releasing a key nobody holds resolves': 'no claim on never-claimed',
      })
    })

    it('fails a store that refuses to claim a key holding a value', async () => {
      const failures = await failures_of(
        broken((base) => ({
          claim: async (key, owner, ttl_ms) =>
            (await base.get(key)) === null && base.claim(key, owner, ttl_ms),
        })),
      )
      expect(failures).toMatchObject({
        'claims and values stay apart': 'a key that holds a value refused a claim',
      })
    })

    it('fails a store whose claim overwrites the value', async () => {
      const failures = await failures_of(
        broken((base) => ({
          claim: async (key, owner, ttl_ms) => {
            await base.set(key, owner)
            return base.claim(key, owner, ttl_ms)
          },
        })),
      )
      expect(failures).toMatchObject({
        'claims and values stay apart': 'claiming a key changed its value',
      })
    })

    it('fails a store whose delete drops the claim on the same key', async () => {
      const failures = await failures_of(
        broken((base) => {
          const holders = new Map<string, string>()
          return {
            claim: async (key, owner) => {
              const holder = holders.get(key)
              if (holder !== undefined && holder !== owner) return false
              holders.set(key, owner)
              return true
            },
            release: async (key, owner) => {
              if (holders.get(key) === owner) holders.delete(key)
            },
            delete: async (key) => {
              await base.delete(key)
              holders.delete(key)
            },
          }
        }),
      )
      expect(failures).toMatchObject({
        'claims and values stay apart': 'deleting a value released the claim on the same key',
      })
    })

    it('fails a store whose claim leaves a value behind', async () => {
      const failures = await failures_of(
        broken((base) => ({
          claim: async (key, owner, ttl_ms) => {
            if ((await base.get(key)) === null) await base.set(key, owner)
            return base.claim(key, owner, ttl_ms)
          },
        })),
      )
      expect(failures).toMatchObject({
        'claims and values stay apart': 'claiming a key gave it a value',
      })
    })

    it('fails a store with one claim for every key', async () => {
      const failures = await failures_of(
        broken((base) => ({
          claim: (_, owner, ttl_ms) => base.claim('the-lock', owner, ttl_ms),
          release: (_, owner) => base.release('the-lock', owner),
        })),
      )
      expect(failures).toMatchObject({
        'different keys are claimed apart': "a claim on 'a' blocked a claim on 'b'",
      })
    })

    it('fails a store whose claims never expire', async () => {
      const failures = await failures_of(
        broken((base) => ({ claim: (key, owner) => base.claim(key, owner, 60_000) })),
      )
      expect(failures).toMatchObject({
        'an expired claim passes to another owner': 'a claim was still held after its 20ms ran out',
        'exactly one racing claimer takes an expired claim':
          '8 owners raced for an expired claim and 0 won',
      })
    })

    it('fails a store whose renewal keeps the original expiry', async () => {
      const failures = await failures_of(
        broken(() => {
          const expiry = new Map<string, { owner: string; expires_at: number }>()
          return {
            claim: async (key, owner, ttl_ms) => {
              const current = expiry.get(key)
              const now = Date.now()
              if (current !== undefined && current.expires_at > now) return current.owner === owner
              expiry.set(key, { owner, expires_at: now + ttl_ms })
              return true
            },
          }
        }),
        // A longer lifetime widens the window the check judges in, so a busy
        // machine can't oversleep it.
        { ttl_ms: 100 },
      )
      expect(failures).toMatchObject({
        'renewing restarts the clock': 'a renewed claim expired on its original schedule',
      })
    })

    it("doesn't judge a renewal when the machine oversleeps its lifetime", async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1_000_000)
      try {
        const report = await checkpoint_store_conformance(
          broken((base) => {
            let renewals = 0
            return {
              claim: async (key, owner, ttl_ms) => {
                const held = await base.claim(key, owner, ttl_ms)
                // The clock leaps past the renewed lifetime on the renewal, the
                // way a machine that stalled mid-check would see it.
                if (key === 'k' && owner === 'first' && ++renewals === 2) {
                  vi.setSystemTime(Date.now() + 10 * ttl_ms)
                }
                return held
              },
            }
          }),
          { ttl_ms: 20 },
        )
        expect(report.passed).toContain('renewing restarts the clock')
      } finally {
        vi.useRealTimers()
      }
    })

    it('fails a store that hands an expired claim to every racer', async () => {
      const failures = await failures_of(
        broken(() => {
          const claims = new Map<string, { owner: string; expires_at: number }>()
          return {
            claim: async (key, owner, ttl_ms) => {
              const current = claims.get(key)
              if (current !== undefined && current.expires_at > Date.now()) {
                return current.owner === owner
              }
              // Checks expiry, then yields before writing: every racer that
              // saw the claim expired goes on to take it.
              if (current !== undefined) await sleep(1)
              claims.set(key, { owner, expires_at: Date.now() + ttl_ms })
              return true
            },
            release: async (key, owner) => {
              if (claims.get(key)?.owner === owner) claims.delete(key)
            },
          }
        }),
      )
      expect(failures).toMatchObject({
        'exactly one racing claimer takes an expired claim':
          '8 owners raced for an expired claim and 8 won',
      })
    })

    it('fails scoped claims that share one key space', async () => {
      const failures = await failures_of(
        broken((base) => ({
          scope: (prefix) => ({ ...base.scope(prefix), claim: base.claim, release: base.release }),
        })),
      )
      expect(failures).toMatchObject({
        'claims in different scopes stay apart': "scope 'b' couldn't claim a key held in scope 'a'",
      })
    })

    it("fails scoped claims that block the parent's", async () => {
      const failures = await failures_of(
        broken((base) => ({
          claim: (key, owner, ttl_ms) => base.scope('a').claim(key, owner, ttl_ms),
        })),
      )
      expect(failures).toMatchObject({
        'claims in different scopes stay apart': "the parent couldn't claim a key held in a scope",
      })
    })
  })
})
