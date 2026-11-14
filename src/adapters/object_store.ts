/**
 * Object-store-backed checkpoint store.
 *
 * Satisfies `CheckpointStore` from `core`, every optional capability
 * included, over a small client interface, so a durable run can live in a
 * bucket that every host in a fleet reaches. The store needs four things of
 * the service: get, put, delete, and a paginated list by prefix, plus the two
 * conditional puts that S3 and the services shaped like it have.
 * `If-None-Match: *` creates a key only while it's absent, and `If-Match`
 * replaces one only while its ETag still matches. Fascicle ships no client
 * and depends on no cloud SDK. `ObjectClient` is the seam, and
 * `docs/human-in-the-loop.md` shows one for `@aws-sdk/client-s3`.
 *
 * A scope is a key prefix, which makes `clear` a paginated list and a delete
 * per key, with the scope's own claims deleted last, so whoever holds a claim
 * on the scope (the lease that `durable` deletes a run under) holds it until
 * everything else is gone. Every name is percent-encoded before it joins a key, dots
 * included, and values, claims, and nested scopes each take a segment of
 * their own (`v/`, `c/`, `s/`), so two names can't land on one object however
 * alike they look. A name whose encoding runs past `MAX_SEGMENT` characters
 * is cut and given a hash of the whole name, which keeps a key under S3's
 * 1,024-byte limit through several scopes.
 *
 * A value's version is its ETag. A claim is an object holding its owner and
 * expiry, and every change to it is a conditional put on the ETag the
 * claimer read, so when claimers race, the bucket accepts exactly one of
 * them. The store never asks for a conditional delete, which not every
 * service has, so a release overwrites the claim as expired.
 *
 * A failed condition is read again before it counts. A client that retries
 * a put whose answer got lost sees its own earlier write as the conflict, so
 * when the object's body is the one this call tried to write, the write
 * landed. That reading is safe as long as no two writers send the same body,
 * which holds for a claim (it carries its owner and expiry) and for a
 * durable run's record (it carries its revision).
 *
 * The store needs a read, and a list, to see the last write. A bucket whose
 * reads lag its writes (some multi-region setups) can't hold a run.
 */

import { createHash } from 'node:crypto'
import type { CheckpointStore } from '#core'

/** The slice of an S3-style client that the store needs. */
export type ObjectClient = {
  /** The object and its ETag, or `undefined` when there's none. */
  readonly get: (
    key: string,
  ) => Promise<{ readonly body: string; readonly etag: string } | undefined>
  /**
   * Write the object, only while it's absent (`if_none_match: '*'`) or only
   * while its ETag still matches (`if_match`) when a condition is given.
   * Resolves false when the condition failed, and throws on anything else.
   */
  readonly put: (key: string, body: string, condition?: ObjectPutCondition) => Promise<boolean>
  readonly delete: (key: string) => Promise<void>
  /** One page of the keys under `prefix`, after `start_after` when given. */
  readonly list: (
    prefix: string,
    start_after?: string,
  ) => Promise<{ readonly keys: ReadonlyArray<string>; readonly next?: string }>
}

/**
 * The condition on a put: create the key only while it's absent, or replace
 * it only while its ETag still matches.
 */
export type ObjectPutCondition = { readonly if_none_match: '*' } | { readonly if_match: string }

export type ObjectStoreConfig = {
  readonly client: ObjectClient
  /** The key prefix that every object goes under, such as `'runs/'`. */
  readonly prefix?: string
}

/**
 * What `object_store` returns: a `CheckpointStore` with every optional
 * capability, which is what `durable` needs from its store.
 */
export type ObjectStore = Required<Omit<CheckpointStore, 'scope'>> & {
  readonly scope: (prefix: string) => ObjectScopedStore
}

/**
 * A scope of an `object_store`, which can also `clear`.
 */
export type ObjectScopedStore = ObjectStore & {
  readonly clear: () => Promise<void>
}

type ClaimRecord = {
  readonly owner: string
  readonly expires_at: number
}

// Values, claims, and nested scopes each take their own segment under a
// scope's prefix.
const VALUE = 'v/'
const CLAIM = 'c/'
const SCOPE = 's/'

// The longest a name's encoding runs before it's cut and hashed.
const MAX_SEGMENT = 128

// How much of a long name's encoding stays readable in front of its hash.
const KEPT = 64

/**
 * Encode a key or a scope prefix as one segment of an object key.
 *
 * Percent encoding leaves no `/` inside a name, so a value's key can never
 * pass for a nested scope's prefix, and dots are encoded too, because some
 * HTTP layers rewrite `.` and `..` segments in a path. A long name keeps the
 * start of its encoding and takes a hash of the whole name after a dot.
 * Nothing else puts a dot in a segment, so a hashed name can't land on a
 * short one.
 */
function segment(name: string): string {
  const encoded = encodeURIComponent(name).replaceAll('.', '%2E')
  if (encoded.length <= MAX_SEGMENT) return encoded
  const hash = createHash('sha256').update(name).digest('hex')
  return `${encoded.slice(0, KEPT).replaceAll('%', '_')}.${hash}`
}

/**
 * Parse a stored body, reading anything that isn't whole JSON as a miss.
 */
function parse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return null
  }
}

/**
 * Serialize a value as JSON. A value that JSON has no text for (`undefined`,
 * a bare function) is written as `null`, which reads back as a miss.
 */
function to_json(value: unknown): string {
  const text: string | undefined = JSON.stringify(value)
  return text ?? 'null'
}

/**
 * Read a claim object back, or `null` when its body isn't a claim.
 */
function read_claim(body: string): ClaimRecord | null {
  const parsed = parse(body)
  if (typeof parsed !== 'object' || parsed === null) return null
  const owner: unknown = Reflect.get(parsed, 'owner')
  const expires_at: unknown = Reflect.get(parsed, 'expires_at')
  return typeof owner === 'string' && typeof expires_at === 'number' ? { owner, expires_at } : null
}

/**
 * Put `body` under `key` if `condition` holds, resolving whether the object
 * now holds this call's write.
 *
 * A failed condition usually means another writer got there first. It can
 * also be this call's own write, landed by an attempt whose answer was lost
 * and refused on the retry, so the object is read again, and a body
 * identical to `body` counts as the write landing.
 */
async function put_if(
  client: ObjectClient,
  key: string,
  body: string,
  condition: ObjectPutCondition,
): Promise<boolean> {
  if (await client.put(key, body, condition)) return true
  const current = await client.get(key)
  return current?.body === body
}

/**
 * Take or renew the claim at `key` for `owner`.
 *
 * A key nobody has claimed is created with `If-None-Match: *`. Anything else
 * that isn't a live claim held by another owner is replaced with `If-Match`
 * on the ETag just read, which covers both a renewal and the takeover of an
 * expired claim. Either way, a claimer that read a state someone else has
 * since changed loses the put.
 */
async function claim_at(
  client: ObjectClient,
  key: string,
  owner: string,
  ttl_ms: number,
): Promise<boolean> {
  const current = await client.get(key)
  const now = Date.now()
  const held = current === undefined ? null : read_claim(current.body)
  if (held !== null && held.expires_at > now && held.owner !== owner) return false
  const body = JSON.stringify({ owner, expires_at: now + ttl_ms })
  return put_if(client, key, body, current === undefined ? { if_none_match: '*' } : { if_match: current.etag })
}

/**
 * Release the claim at `key` when `owner` holds it.
 *
 * The claim is overwritten as expired, on the ETag just read, and never
 * deleted. A plain delete could erase a claim that another owner took after
 * the read, and a conditional delete isn't something every service has. A
 * put that loses means the claim changed hands, which leaves nothing to
 * release.
 */
async function release_at(client: ObjectClient, key: string, owner: string): Promise<void> {
  const current = await client.get(key)
  if (current === undefined || read_claim(current.body)?.owner !== owner) return
  await client.put(key, JSON.stringify({ owner, expires_at: 0 }), { if_match: current.etag })
}

/**
 * Delete every object whose key starts with `prefix`, a page at a time, and
 * the claims directly under it after everything else.
 *
 * A listing is sorted, and `c/` sorts ahead of `s/` and `v/`, so deleting in
 * listing order would free a claim on the scope while later pages still held
 * its values. A caller that clears under a claim, as `durable` deletes a run
 * under its lease, keeps that claim until the rest of the scope is gone.
 */
async function delete_prefix(client: ObjectClient, prefix: string): Promise<void> {
  const claims = `${prefix}${CLAIM}`
  const held: string[] = []
  let start_after: string | undefined
  for (;;) {
    const page = await client.list(prefix, start_after)
    held.push(...page.keys.filter((key) => key.startsWith(claims)))
    await Promise.all(page.keys.filter((key) => !key.startsWith(claims)).map((key) => client.delete(key)))
    if (page.next === undefined) break
    start_after = page.next
  }
  await Promise.all(held.map((key) => client.delete(key)))
}

/**
 * Build the store whose keys live under `base`.
 */
function store_at(client: ObjectClient, base: string): ObjectStore {
  const value_key = (key: string): string => `${base}${VALUE}${segment(key)}`
  const claim_key = (key: string): string => `${base}${CLAIM}${segment(key)}`

  const scope = (prefix: string): ObjectScopedStore => {
    const dir = `${base}${SCOPE}${segment(prefix)}/`
    return { ...store_at(client, dir), clear: () => delete_prefix(client, dir) }
  }

  return {
    get: async (key) => {
      const object = await client.get(value_key(key))
      return object === undefined ? null : parse(object.body)
    },
    set: async (key, value) => {
      await client.put(value_key(key), to_json(value))
    },
    delete: (key) => client.delete(value_key(key)),
    scope,
    claim: (key, owner, ttl_ms) => claim_at(client, claim_key(key), owner, ttl_ms),
    release: (key, owner) => release_at(client, claim_key(key), owner),
    get_versioned: async (key) => {
      const object = await client.get(value_key(key))
      if (object === undefined) return undefined
      const parsed = parse(object.body)
      return { value: parsed === null ? undefined : parsed, version: object.etag }
    },
    set_if: (key, value, expected) =>
      put_if(
        client,
        value_key(key),
        to_json(value),
        expected === null ? { if_none_match: '*' } : { if_match: expected },
      ),
  }
}

/**
 * Create a `CheckpointStore` that keeps its values, claims, and scopes as
 * objects behind `config.client`, under `config.prefix`.
 *
 * Run `checkpoint_store_conformance` from `fascicle/testing` against a real
 * bucket once before trusting a service with it. A service that accepts a
 * condition and ignores it lets two writers both win, and that suite is what
 * catches it.
 */
export function object_store(config: ObjectStoreConfig): ObjectStore {
  return store_at(config.client, config.prefix ?? '')
}
