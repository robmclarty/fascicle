/**
 * checkpoint_store_conformance: prove that a store keeps the
 * `CheckpointStore` contract.
 *
 * A store is three small functions, and their semantics are the subtle part.
 * A damaged value has to read as a miss rather than throw, two keys can't
 * share storage just because they encode alike, and a claim has to refuse a
 * second owner even when both ask at the same moment. A conditional write
 * has to let exactly one of several racing writers through. The suite runs
 * every check against a fresh store from `make_store`, adds the scope,
 * claim, and compare-and-set checks when the store offers those
 * capabilities, and reports what passed, what failed, and what it skipped.
 * It returns that report instead of registering tests, so it works under any
 * test runner: assert that `failed` is empty.
 */

import type { CheckpointStore, ScopedCheckpointStore, Versioned } from '#core'

export type StoreConformanceOptions = {
  /**
   * Damage the value stored at `key` the way a torn write or a bad disk
   * would. Given, the suite checks that a damaged value reads as a miss, and
   * that `get_versioned` still reads it with a version.
   */
  readonly corrupt?: (store: CheckpointStore, key: string) => Promise<void> | void
  /**
   * The claim lifetime, in milliseconds, of the checks that wait for a claim
   * to expire. A store with a coarse clock may need it longer. Default 200.
   */
  readonly ttl_ms?: number
}

export type StoreConformanceFailure = {
  readonly check: string
  readonly message: string
}

export type StoreConformanceReport = {
  readonly passed: ReadonlyArray<string>
  readonly failed: ReadonlyArray<StoreConformanceFailure>
  readonly skipped: ReadonlyArray<string>
}

type CheckEnv = {
  readonly ttl_ms: number
  readonly corrupt: (store: CheckpointStore, key: string) => Promise<void> | void
}

type Check = {
  readonly name: string
  readonly run: (store: CheckpointStore, env: CheckEnv) => Promise<void>
}

type Suite = {
  readonly checks: ReadonlyArray<Check>
  readonly applies: (store: CheckpointStore, options: StoreConformanceOptions) => boolean
}

type Claims = {
  readonly claim: (key: string, owner: string, ttl_ms: number) => Promise<boolean>
  readonly release: (key: string, owner: string) => Promise<void>
}

type Cas = {
  readonly get_versioned: (key: string) => Promise<Versioned | undefined>
  readonly set_if: (key: string, value: unknown, expected: string | null) => Promise<boolean>
}

const DEFAULT_TTL_MS = 200

// Long enough that no check outlives it, so a claim taken with it stays held
// for the whole check.
const HELD_MS = 60_000

const RACERS = 8

// Stryker disable StringLiteral: the checks need their keys, prefixes, and
// owners to differ from one another and nothing more, which any distinct
// strings do, so trading one for another can't change what a check proves.
const KEY = 'k'
const MISSING = 'never-set'
const NULL_KEY = 'null'
const UNDEFINED_KEY = 'undefined'
const RACE_KEY = 'race'
const DAMAGED_KEY = 'damaged'
const CLAIMED_ONLY = 'claimed-only'
const UNCLAIMED = 'never-claimed'
const A = 'a'
const B = 'b'
const CHILD = 'child'
const INNER = 'inner'
const UNUSED = 'never-used'
const FIRST = 'first'
const SECOND = 'second'
const THIRD = 'third'
// Stryker restore StringLiteral

const FRESH_SCOPE_CLAIM_REFUSED = 'a claim inside a fresh scope returned false'
const FREE_CLAIM_REFUSED = 'a claim on a key nobody holds returned false'
const RENEWAL_REFUSED = 'the owner could not renew its own live claim'
const CREATE_REFUSED = 'a create on a key that holds nothing was refused'
const FRESH_SCOPE_CREATE_REFUSED = 'a create inside a fresh scope was refused'
const FRESH_WRITE_REFUSED = 'a write on the version just read was refused'

const SAMPLES: ReadonlyArray<unknown> = [
  { candidate: 'a', converged: true, rounds: 2 },
  { nested: { list: [1, 'two', { three: 3 }], empty: {} } },
  [1, 2, 3],
  [],
  {},
  'plain text',
  '',
  'unicode: naïve café, 世界, 🔑',
  0,
  -1.5,
  true,
  false,
]

// Strings a naive encoder would merge: separators that slug to the same
// character, case, path segments, and long strings that differ only at the
// end.
const LOOKALIKES: ReadonlyArray<string> = [
  'a/b',
  'a_b',
  'a:b',
  'a b',
  'A/B',
  'a/b/',
  '../a',
  '.',
  '..',
  '鍵',
  '🔑',
  `${'k'.repeat(200)}1`,
  `${'k'.repeat(200)}2`,
]

// Prefixes a nested scope `a` then `b` could be confused with by a store
// that joins prefixes into one string.
const FLATTENED = ['a/b', 'ab', 'a.b', 'a:b', 'b']

// Prefixes that begin the way `a` does, or match it but for case, which a
// store that clears scope `a` by deleting everything under a raw prefix (or a
// case-blind one) sweeps away with it.
const BESIDE_A = ['a/b', 'a/', 'ab', 'a.b', 'a b', 'A']

/**
 * Throw a check failure carrying `message` unless `condition` holds.
 */
function ensure(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/**
 * True for what the contract counts as a miss: `null` or `undefined`.
 */
function is_miss(value: unknown): boolean {
  return value === null || value === undefined
}

/**
 * Render a value for a failure message, cut short so a large one stays
 * readable.
 */
function show(value: unknown): string {
  const text: string | undefined = JSON.stringify(value)
  const shown = text ?? String(value)
  return shown.length > 80 ? `${shown.slice(0, 77)}...` : shown
}

/**
 * Serialize a value with its object keys sorted, so two values compare equal
 * when a store hands back the same data in a different key order (Postgres
 * `jsonb` does).
 */
function canonical(value: unknown): string | undefined {
  const text: string | undefined = JSON.stringify(sort_keys(value))
  return text
}

/**
 * Copy a JSON value with every object's keys in sorted order.
 */
function sort_keys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort_keys)
  if (typeof value !== 'object' || value === null) return value
  // Stryker disable next-line EqualityOperator: object keys are unique, so `<=` sorts like `<`, and a reversed sort is applied to both sides of every comparison.
  const entries = Object.entries(value).toSorted(([x], [y]) => (x < y ? -1 : 1))
  return Object.fromEntries(entries.map(([k, v]) => [k, sort_keys(v)]))
}

/**
 * Wait `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Open the scope at `prefix`, or fail the check when the store handed to it
 * has no `scope` (a `make_store` whose stores don't all offer the same
 * capabilities).
 */
function scope_of(store: CheckpointStore, prefix: string): ScopedCheckpointStore {
  if (store.scope === undefined) throw new Error('make_store returned a store without scope')
  return store.scope(prefix)
}

/**
 * The store's claim pair, or a failure naming the half that's missing. Both
 * are called on the store itself, the way `durable` calls them, so a store
 * whose methods lean on `this` works here too.
 */
function claims_of(store: CheckpointStore): Claims {
  const { claim, release } = store
  if (claim === undefined && release === undefined) {
    throw new Error('the store has neither claim nor release')
  }
  if (claim === undefined) throw new Error('the store offers release without claim')
  if (release === undefined) throw new Error('the store offers claim without release')
  return {
    claim: (key, owner, ttl_ms) => claim.call(store, key, owner, ttl_ms),
    release: (key, owner) => release.call(store, key, owner),
  }
}

/**
 * Claim `key` for many owners at the same moment and count the winners.
 */
async function race_for(claims: Claims, key: string): Promise<number> {
  const owners = Array.from({ length: RACERS }, (_, i) => `racer-${i}`)
  const won = await Promise.all(owners.map((owner) => claims.claim(key, owner, HELD_MS)))
  return won.filter(Boolean).length
}

/**
 * The store's compare-and-set pair, or a failure naming the half that's
 * missing. Both are called on the store itself, as `claims_of` does.
 */
function cas_of(store: CheckpointStore): Cas {
  const { get_versioned, set_if } = store
  if (get_versioned === undefined && set_if === undefined) {
    throw new Error('the store has neither get_versioned nor set_if')
  }
  if (get_versioned === undefined) throw new Error('the store offers set_if without get_versioned')
  if (set_if === undefined) throw new Error('the store offers get_versioned without set_if')
  return {
    get_versioned: (key) => get_versioned.call(store, key),
    set_if: (key, value, expected) => set_if.call(store, key, value, expected),
  }
}

/**
 * Read `key` with its version, failing the check when the store reports a
 * key that holds something as absent, or hands back a version that isn't a
 * string.
 */
async function held_version(cas: Cas, key: string): Promise<Versioned> {
  const read = await cas.get_versioned(key)
  if (read === undefined) throw new Error('get_versioned read a key that holds something as absent')
  ensure(typeof read.version === 'string', `get_versioned returned the version ${show(read.version)}`)
  return read
}

/**
 * The value that racer `writer` writes, which no other racer does.
 */
function racer_value(writer: number | undefined): unknown {
  return { writer }
}

/**
 * Write `RACE_KEY` on `expected` from many writers at the same moment, and
 * fail the check unless the store accepted exactly one of them and holds
 * what that one wrote. `kind` names the write (a create, or a write) and
 * `raced` says what the writers raced for, both for the failure message.
 */
async function ensure_one_winner(
  store: CheckpointStore,
  expected: string | null,
  kind: string,
  raced: string,
): Promise<void> {
  const cas = cas_of(store)
  const writers = Array.from({ length: RACERS }, (_, i) => i)
  const won = await Promise.all(writers.map((i) => cas.set_if(RACE_KEY, racer_value(i), expected)))
  const winners = writers.filter((i) => won[i])
  ensure(winners.length === 1, `${RACERS} ${kind}s raced ${raced} and ${winners.length} won`)
  const value = await store.get(RACE_KEY)
  ensure(
    canonical(value) === canonical(racer_value(winners[0])),
    `the key holds ${show(value)}, which the ${kind} that won never wrote`,
  )
}

const CONTRACT_CHECKS: ReadonlyArray<Check> = [
  {
    name: 'a missing key reads as a miss',
    run: async (store) => {
      const value = await store.get(MISSING)
      ensure(is_miss(value), `get on a key nobody set returned ${show(value)}`)
    },
  },
  {
    name: 'values round-trip as JSON',
    run: async (store) => {
      await Promise.all(SAMPLES.map((sample, i) => store.set(`sample-${i}`, sample)))
      const read = await Promise.all(SAMPLES.map((_, i) => store.get(`sample-${i}`)))
      SAMPLES.forEach((sample, i) => {
        ensure(
          canonical(read[i]) === canonical(sample),
          `set ${show(sample)} and got back ${show(read[i])}`,
        )
      })
    },
  },
  {
    name: 'set overwrites a value',
    run: async (store) => {
      await store.set(KEY, { v: 1 })
      await store.set(KEY, { v: 2 })
      const value = await store.get(KEY)
      ensure(canonical(value) === canonical({ v: 2 }), `a second set lost to the first: ${show(value)}`)
    },
  },
  {
    name: 'delete removes a value',
    run: async (store) => {
      await store.set(KEY, { v: 1 })
      await store.delete(KEY)
      const value = await store.get(KEY)
      ensure(is_miss(value), `get after delete returned ${show(value)}`)
    },
  },
  {
    name: 'deleting a missing key resolves',
    run: async (store) => {
      await store.delete(MISSING)
    },
  },
  {
    name: 'a stored null or undefined reads as a miss',
    run: async (store) => {
      await store.set(NULL_KEY, null)
      await store.set(UNDEFINED_KEY, undefined)
      ensure(is_miss(await store.get(NULL_KEY)), 'a stored null read back as a hit')
      ensure(is_miss(await store.get(UNDEFINED_KEY)), 'a stored undefined read back as a hit')
    },
  },
  {
    name: 'keys that encode alike stay apart',
    run: async (store) => {
      await Promise.all(LOOKALIKES.map((key, i) => store.set(key, i)))
      const read = await Promise.all(LOOKALIKES.map((key) => store.get(key)))
      LOOKALIKES.forEach((key, i) => {
        ensure(read[i] === i, `key ${show(key)} read back ${show(read[i])}, another key's value`)
      })
    },
  },
  {
    name: 'racing writes leave one whole value',
    run: async (store) => {
      const writes = Array.from({ length: RACERS }, (_, i) => ({
        writer: i,
        // Stryker disable next-line ArithmeticOperator: each write only has to differ from the others, which `writer` already ensures, so the body's exact length is immaterial.
        body: 'x'.repeat(4096 + i),
      }))
      await Promise.all(writes.map((write) => store.set(RACE_KEY, write)))
      const value = await store.get(RACE_KEY)
      ensure(
        writes.some((write) => canonical(write) === canonical(value)),
        `after ${RACERS} racing sets, get returned ${show(value)}, which none of them wrote`,
      )
    },
  },
]

const DAMAGE_CHECK: Check = {
  name: 'a damaged value reads as a miss',
  run: async (store, env) => {
    await store.set(DAMAGED_KEY, { ok: true })
    await env.corrupt(store, DAMAGED_KEY)
    let value: unknown
    try {
      value = await store.get(DAMAGED_KEY)
    } catch (err) {
      // Stryker disable next-line ObjectLiteral: the report carries the message alone, so the cause is there for a debugger and nothing reads it.
      throw new Error(`get threw on a damaged value instead of missing: ${String(err)}`, {
        cause: err,
      })
    }
    ensure(is_miss(value), `get on a damaged value returned ${show(value)}`)
  },
}

const SCOPE_CHECKS: ReadonlyArray<Check> = [
  {
    name: 'a scope is apart from its parent',
    run: async (store) => {
      const child = scope_of(store, CHILD)
      await store.set(KEY, 'parent')
      ensure(is_miss(await child.get(KEY)), "a scope read its parent's value")
      await child.set(KEY, 'child')
      ensure((await store.get(KEY)) === 'parent', "a write in a scope changed its parent's value")
      ensure((await child.get(KEY)) === 'child', 'a scope lost its own value')
    },
  },
  {
    name: 'one prefix reaches the same data, another prefix does not',
    run: async (store) => {
      await scope_of(store, A).set(KEY, 'a')
      ensure((await scope_of(store, A).get(KEY)) === 'a', 'reopening a scope lost its value')
      ensure(is_miss(await scope_of(store, B).get(KEY)), "scope 'b' read a value set in scope 'a'")
    },
  },
  {
    name: 'prefixes that encode alike stay apart',
    run: async (store) => {
      await Promise.all(LOOKALIKES.map((prefix, i) => scope_of(store, prefix).set(KEY, i)))
      const read = await Promise.all(LOOKALIKES.map((prefix) => scope_of(store, prefix).get(KEY)))
      LOOKALIKES.forEach((prefix, i) => {
        ensure(read[i] === i, `scope ${show(prefix)} read back ${show(read[i])}, another scope's`)
      })
    },
  },
  {
    name: 'nested scopes stay apart from look-alike prefixes',
    run: async (store) => {
      await scope_of(store, A).scope(B).set(KEY, 'nested')
      const read = await Promise.all(FLATTENED.map((prefix) => scope_of(store, prefix).get(KEY)))
      FLATTENED.forEach((prefix, i) => {
        ensure(is_miss(read[i]), `scope ${show(prefix)} read the value of scope 'b' in scope 'a'`)
      })
      const a = scope_of(store, A)
      ensure(is_miss(await a.get(KEY)), "a nested scope's value showed up in its parent")
      ensure((await a.scope(B).get(KEY)) === 'nested', 'reopening a nested scope lost its value')
    },
  },
  {
    name: 'clear empties a scope and nothing else',
    run: async (store) => {
      const a = scope_of(store, A)
      await Promise.all([
        store.set(KEY, 'root'),
        a.set(KEY, 'a'),
        a.scope(INNER).set(KEY, 'inner'),
        scope_of(store, B).set(KEY, 'b'),
      ])
      await a.clear()
      ensure(is_miss(await a.get(KEY)), 'a value survived clear')
      ensure(is_miss(await a.scope(INNER).get(KEY)), "a nested scope's value survived clear")
      ensure((await scope_of(store, B).get(KEY)) === 'b', "clear removed a sibling's value")
      ensure((await store.get(KEY)) === 'root', "clear removed the parent's value")
      await a.set(KEY, 'again')
      ensure((await a.get(KEY)) === 'again', 'a cleared scope refused a new value')
    },
  },
  {
    name: 'clear leaves look-alike scopes alone',
    run: async (store) => {
      await Promise.all(BESIDE_A.map((prefix, i) => scope_of(store, prefix).set(KEY, i)))
      await scope_of(store, A).clear()
      const read = await Promise.all(BESIDE_A.map((prefix) => scope_of(store, prefix).get(KEY)))
      BESIDE_A.forEach((prefix, i) => {
        ensure(read[i] === i, `clearing scope 'a' emptied scope ${show(prefix)}`)
      })
    },
  },
  {
    name: 'clearing an empty scope resolves',
    run: async (store) => {
      await scope_of(store, UNUSED).clear()
    },
  },
]

const SCOPED_CLAIM_CHECKS: ReadonlyArray<Check> = [
  {
    name: 'scopes keep the claim capability',
    run: async (store) => {
      const claims = claims_of(scope_of(store, A))
      ensure(await claims.claim(KEY, FIRST, HELD_MS), FRESH_SCOPE_CLAIM_REFUSED)
    },
  },
  {
    name: 'claims in different scopes stay apart',
    run: async (store) => {
      const first = await claims_of(scope_of(store, A)).claim(KEY, FIRST, HELD_MS)
      const second = await claims_of(scope_of(store, B)).claim(KEY, SECOND, HELD_MS)
      const third = await claims_of(store).claim(KEY, THIRD, HELD_MS)
      ensure(first, FRESH_SCOPE_CLAIM_REFUSED)
      ensure(second, "scope 'b' couldn't claim a key held in scope 'a'")
      ensure(third, "the parent couldn't claim a key held in a scope")
    },
  },
  {
    name: 'clear drops the claims under a scope',
    run: async (store) => {
      const a = scope_of(store, A)
      ensure(await claims_of(a).claim(KEY, FIRST, HELD_MS), FRESH_SCOPE_CLAIM_REFUSED)
      await a.clear()
      ensure(await claims_of(a).claim(KEY, SECOND, HELD_MS), 'a claim survived clear')
    },
  },
]

const CLAIM_CHECKS: ReadonlyArray<Check> = [
  {
    name: 'claim comes with release',
    run: async (store) => {
      claims_of(store)
    },
  },
  {
    name: 'a free key can be claimed',
    run: async (store) => {
      ensure(await claims_of(store).claim(KEY, FIRST, HELD_MS), FREE_CLAIM_REFUSED)
    },
  },
  {
    name: 'a held key refuses another owner',
    run: async (store) => {
      const claims = claims_of(store)
      await claims.claim(KEY, FIRST, HELD_MS)
      const second = await claims.claim(KEY, SECOND, HELD_MS)
      ensure(!second, 'a second owner claimed a key the first still holds')
    },
  },
  {
    name: 'the owner can renew its claim',
    run: async (store) => {
      const claims = claims_of(store)
      await claims.claim(KEY, FIRST, HELD_MS)
      ensure(await claims.claim(KEY, FIRST, HELD_MS), RENEWAL_REFUSED)
    },
  },
  {
    name: 'release lets another owner in',
    run: async (store) => {
      const claims = claims_of(store)
      await claims.claim(KEY, FIRST, HELD_MS)
      await claims.release(KEY, FIRST)
      ensure(await claims.claim(KEY, SECOND, HELD_MS), 'a released key refused the next owner')
    },
  },
  {
    name: 'release by another owner changes nothing',
    run: async (store) => {
      const claims = claims_of(store)
      await claims.claim(KEY, FIRST, HELD_MS)
      await claims.release(KEY, SECOND)
      const second = await claims.claim(KEY, SECOND, HELD_MS)
      ensure(!second, "a release by a non-owner freed the owner's claim")
    },
  },
  {
    name: 'releasing a key nobody holds resolves',
    run: async (store) => {
      await claims_of(store).release(UNCLAIMED, FIRST)
    },
  },
  {
    name: 'claims and values stay apart',
    run: async (store) => {
      const claims = claims_of(store)
      await store.set(KEY, 'value')
      ensure(await claims.claim(KEY, FIRST, HELD_MS), 'a key that holds a value refused a claim')
      ensure((await store.get(KEY)) === 'value', 'claiming a key changed its value')
      await store.delete(KEY)
      const second = await claims.claim(KEY, SECOND, HELD_MS)
      ensure(!second, 'deleting a value released the claim on the same key')
      await claims.claim(CLAIMED_ONLY, FIRST, HELD_MS)
      ensure(is_miss(await store.get(CLAIMED_ONLY)), 'claiming a key gave it a value')
    },
  },
  {
    name: 'different keys are claimed apart',
    run: async (store) => {
      const claims = claims_of(store)
      ensure(await claims.claim(A, FIRST, HELD_MS), FREE_CLAIM_REFUSED)
      ensure(await claims.claim(B, SECOND, HELD_MS), "a claim on 'a' blocked a claim on 'b'")
    },
  },
  {
    name: 'exactly one racing claimer wins a free key',
    run: async (store) => {
      const winners = await race_for(claims_of(store), KEY)
      ensure(winners === 1, `${RACERS} owners raced for a free key and ${winners} won`)
    },
  },
  {
    name: 'an expired claim passes to another owner',
    run: async (store, env) => {
      const claims = claims_of(store)
      await claims.claim(KEY, FIRST, env.ttl_ms)
      await sleep(env.ttl_ms * 2)
      const second = await claims.claim(KEY, SECOND, HELD_MS)
      ensure(second, `a claim was still held after its ${env.ttl_ms}ms ran out`)
      const first = await claims.claim(KEY, FIRST, HELD_MS)
      ensure(!first, 'the first owner took back a claim that had passed to another')
    },
  },
  {
    name: 'exactly one racing claimer takes an expired claim',
    run: async (store, env) => {
      const claims = claims_of(store)
      await claims.claim(KEY, FIRST, env.ttl_ms)
      await sleep(env.ttl_ms * 2)
      const winners = await race_for(claims, KEY)
      ensure(winners === 1, `${RACERS} owners raced for an expired claim and ${winners} won`)
    },
  },
  {
    name: 'renewing restarts the clock',
    run: async (store, env) => {
      const claims = claims_of(store)
      const started = Date.now()
      await claims.claim(KEY, FIRST, env.ttl_ms)
      await sleep(env.ttl_ms / 2)
      const renewed = Date.now()
      ensure(await claims.claim(KEY, FIRST, env.ttl_ms), RENEWAL_REFUSED)
      await sleep(Math.max(0, started + env.ttl_ms * 1.2 - Date.now()))
      const second = await claims.claim(KEY, SECOND, HELD_MS)
      // A machine slow enough to reach the end of the renewed lifetime before
      // the second claim returns, oversleeping or stalling inside the claim,
      // can't tell a renewal from none, so the check judges only a claim that
      // finished inside it.
      if (Date.now() >= renewed + env.ttl_ms) return
      ensure(!second, 'a renewed claim expired on its original schedule')
    },
  },
]

const CAS_CHECKS: ReadonlyArray<Check> = [
  {
    name: 'get_versioned comes with set_if',
    run: async (store) => {
      cas_of(store)
    },
  },
  {
    name: 'a missing key has no version',
    run: async (store) => {
      const read = await cas_of(store).get_versioned(MISSING)
      ensure(read === undefined, `get_versioned on a key nobody set returned ${show(read)}`)
    },
  },
  {
    name: 'a stored null reads with a version',
    run: async (store) => {
      const cas = cas_of(store)
      await store.set(NULL_KEY, null)
      const read = await held_version(cas, NULL_KEY)
      ensure(is_miss(read.value), `a stored null read back as ${show(read.value)}`)
      const replaced = await cas.set_if(NULL_KEY, { v: 1 }, read.version)
      ensure(replaced, 'a write on the version of a stored null was refused')
      const value = await store.get(NULL_KEY)
      ensure(canonical(value) === canonical({ v: 1 }), `the write over a null left ${show(value)}`)
    },
  },
  {
    name: 'a create lands on an absent key',
    run: async (store) => {
      ensure(await cas_of(store).set_if(KEY, { v: 1 }, null), CREATE_REFUSED)
      const value = await store.get(KEY)
      ensure(canonical(value) === canonical({ v: 1 }), `a create that won left ${show(value)}`)
    },
  },
  {
    name: 'a create refuses a key that holds anything',
    run: async (store) => {
      const cas = cas_of(store)
      await store.set(KEY, { v: 1 })
      const over_value = await cas.set_if(KEY, { v: 2 }, null)
      ensure(!over_value, 'a create landed on a key that holds a value')
      const value = await store.get(KEY)
      ensure(canonical(value) === canonical({ v: 1 }), `a refused create left ${show(value)}`)
      await store.set(NULL_KEY, null)
      const over_null = await cas.set_if(NULL_KEY, { v: 2 }, null)
      ensure(!over_null, 'a create landed on a key that holds a stored null')
    },
  },
  {
    name: 'exactly one racing create wins',
    run: (store) => ensure_one_winner(store, null, 'create', 'for an absent key'),
  },
  {
    name: 'a write on the version it read lands and moves the version',
    run: async (store) => {
      const cas = cas_of(store)
      await store.set(KEY, { v: 1 })
      const before = await held_version(cas, KEY)
      ensure(canonical(before.value) === canonical({ v: 1 }), `get_versioned read ${show(before.value)}`)
      ensure(await cas.set_if(KEY, { v: 2 }, before.version), FRESH_WRITE_REFUSED)
      const after = await held_version(cas, KEY)
      ensure(canonical(after.value) === canonical({ v: 2 }), `the write left ${show(after.value)}`)
      ensure(after.version !== before.version, 'a write that landed left the version where it was')
    },
  },
  {
    name: 'a write on a stale version is refused and changes nothing',
    run: async (store) => {
      const cas = cas_of(store)
      await store.set(KEY, { v: 1 })
      const stale = await held_version(cas, KEY)
      ensure(await cas.set_if(KEY, { v: 2 }, stale.version), FRESH_WRITE_REFUSED)
      const current = await held_version(cas, KEY)
      const late = await cas.set_if(KEY, { v: 3 }, stale.version)
      ensure(!late, 'a write landed on a version another write had already replaced')
      const after = await held_version(cas, KEY)
      ensure(canonical(after.value) === canonical({ v: 2 }), `a refused write left ${show(after.value)}`)
      ensure(after.version === current.version, 'a refused write moved the version')
    },
  },
  {
    name: 'exactly one racing write on one version wins',
    run: async (store) => {
      await store.set(RACE_KEY, { v: 0 })
      const read = await held_version(cas_of(store), RACE_KEY)
      await ensure_one_winner(store, read.version, 'write', 'on one version')
    },
  },
  {
    name: 'set and delete move the version',
    run: async (store) => {
      const cas = cas_of(store)
      await store.set(KEY, { v: 1 })
      const first = await held_version(cas, KEY)
      await store.set(KEY, { v: 2 })
      const second = await held_version(cas, KEY)
      ensure(second.version !== first.version, 'a set left the version where it was')
      const over_set = await cas.set_if(KEY, { v: 3 }, first.version)
      ensure(!over_set, 'a write landed on a version a set had already replaced')
      await store.delete(KEY)
      const gone = await cas.get_versioned(KEY)
      ensure(gone === undefined, `get_versioned after delete returned ${show(gone)}`)
      const over_delete = await cas.set_if(KEY, { v: 3 }, second.version)
      ensure(!over_delete, 'a write landed on the version of a value that was deleted')
      ensure(is_miss(await store.get(KEY)), 'a refused write brought a deleted value back')
    },
  },
  {
    name: 'a create works again after a delete',
    run: async (store) => {
      const cas = cas_of(store)
      ensure(await cas.set_if(KEY, { v: 1 }, null), CREATE_REFUSED)
      await store.delete(KEY)
      ensure(await cas.set_if(KEY, { v: 2 }, null), 'a create was refused on a key that was deleted')
      const value = await store.get(KEY)
      ensure(canonical(value) === canonical({ v: 2 }), `the second create left ${show(value)}`)
    },
  },
]

const CAS_DAMAGE_CHECK: Check = {
  name: 'a damaged value reads with a version',
  run: async (store, env) => {
    const cas = cas_of(store)
    await store.set(DAMAGED_KEY, { ok: true })
    await env.corrupt(store, DAMAGED_KEY)
    let read: Versioned | undefined
    try {
      read = await cas.get_versioned(DAMAGED_KEY)
    } catch (err) {
      // Stryker disable next-line ObjectLiteral: the report carries the message alone, so the cause is there for a debugger and nothing reads it.
      throw new Error(`get_versioned threw on a damaged value: ${String(err)}`, { cause: err })
    }
    if (read === undefined) throw new Error('get_versioned read a damaged value as an absent key')
    ensure(is_miss(read.value), `get_versioned on a damaged value returned ${show(read.value)}`)
    const replaced = await cas.set_if(DAMAGED_KEY, { ok: false }, read.version)
    ensure(replaced, 'a write on the version of a damaged value was refused')
    const value = await store.get(DAMAGED_KEY)
    ensure(canonical(value) === canonical({ ok: false }), `the write over the damage left ${show(value)}`)
  },
}

const SCOPED_CAS_CHECKS: ReadonlyArray<Check> = [
  {
    name: 'scopes keep the compare-and-set capability',
    run: async (store) => {
      const cas = cas_of(scope_of(store, A))
      ensure(await cas.set_if(KEY, { v: 1 }, null), FRESH_SCOPE_CREATE_REFUSED)
      const read = await held_version(cas, KEY)
      ensure(canonical(read.value) === canonical({ v: 1 }), `a scope read back ${show(read.value)}`)
      const parent = await cas_of(store).get_versioned(KEY)
      ensure(parent === undefined, "a create in a scope showed up under its parent's key")
    },
  },
  {
    name: 'a version from one scope satisfies nothing in another',
    run: async (store) => {
      const a = scope_of(store, A)
      const b = scope_of(store, B)
      await a.set(KEY, { v: 1 })
      await b.set(KEY, { v: 2 })
      const in_a = await held_version(cas_of(a), KEY)
      const crossed = await cas_of(b).set_if(KEY, { v: 3 }, in_a.version)
      ensure(!crossed, "a write in scope 'b' landed on a version read in scope 'a'")
      const value = await b.get(KEY)
      ensure(canonical(value) === canonical({ v: 2 }), `the refused write left ${show(value)} in scope 'b'`)
      const beside = await cas_of(scope_of(store, CHILD)).set_if(KEY, { v: 4 }, null)
      ensure(beside, 'a create was refused because another scope holds the key')
    },
  },
  {
    name: 'a create works again after a clear',
    run: async (store) => {
      const a = scope_of(store, A)
      const cas = cas_of(a)
      ensure(await cas.set_if(KEY, { v: 1 }, null), FRESH_SCOPE_CREATE_REFUSED)
      await a.clear()
      const gone = await cas.get_versioned(KEY)
      ensure(gone === undefined, `get_versioned after clear returned ${show(gone)}`)
      ensure(await cas.set_if(KEY, { v: 2 }, null), 'a create was refused on a key that was cleared')
    },
  },
]

/**
 * True when the store offers either half of the compare-and-set, which is
 * when its checks run. A store with only one half fails the first of them.
 */
function has_cas(store: CheckpointStore): boolean {
  return store.get_versioned !== undefined || store.set_if !== undefined
}

const SUITES: ReadonlyArray<Suite> = [
  { checks: CONTRACT_CHECKS, applies: () => true },
  { checks: [DAMAGE_CHECK], applies: (_, options) => options.corrupt !== undefined },
  { checks: SCOPE_CHECKS, applies: (store) => store.scope !== undefined },
  {
    checks: CLAIM_CHECKS,
    applies: (store) => store.claim !== undefined || store.release !== undefined,
  },
  {
    checks: SCOPED_CLAIM_CHECKS,
    applies: (store) => store.scope !== undefined && store.claim !== undefined,
  },
  { checks: CAS_CHECKS, applies: has_cas },
  {
    checks: [CAS_DAMAGE_CHECK],
    applies: (store, options) => has_cas(store) && options.corrupt !== undefined,
  },
  { checks: SCOPED_CAS_CHECKS, applies: (store) => store.scope !== undefined && has_cas(store) },
]

/**
 * Run one check against a fresh store, resolving its failure message or
 * `undefined` when it passed. A `make_store` that throws fails the check.
 */
async function run_check(
  check: Check,
  make_store: () => CheckpointStore | Promise<CheckpointStore>,
  env: CheckEnv,
): Promise<string | undefined> {
  try {
    await check.run(await make_store(), env)
    return undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Check a `CheckpointStore` against the contract, one fresh store per check.
 *
 * The capabilities are read off the first store `make_store` returns: scope
 * checks run when it has `scope`, claim checks when it has `claim` or
 * `release`, compare-and-set checks when it has `get_versioned` or `set_if`,
 * and the damage checks when `options.corrupt` is given. Every other check
 * lands in `skipped`. Checks run one at a time, because some wait
 * on claim expiry and a store's backing service may be shared between the
 * stores `make_store` hands out.
 */
export async function checkpoint_store_conformance(
  make_store: () => CheckpointStore | Promise<CheckpointStore>,
  options: StoreConformanceOptions = {},
): Promise<StoreConformanceReport> {
  const env: CheckEnv = {
    ttl_ms: options.ttl_ms ?? DEFAULT_TTL_MS,
    corrupt: options.corrupt ?? (() => {}),
  }
  const probe = await make_store()
  const passed: string[] = []
  const failed: StoreConformanceFailure[] = []
  const skipped: string[] = []
  for (const suite of SUITES) {
    if (!suite.applies(probe, options)) {
      skipped.push(...suite.checks.map((check) => check.name))
      continue
    }
    for (const check of suite.checks) {
      const message = await run_check(check, make_store, env)
      if (message === undefined) passed.push(check.name)
      else failed.push({ check: check.name, message })
    }
  }
  return { passed, failed, skipped }
}
