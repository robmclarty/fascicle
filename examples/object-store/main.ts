/**
 * object-store: a CheckpointStore written over an object-store client, with
 * the scopes and claims that `durable` needs, so a run that waits at a gate
 * can live in a bucket.
 *
 * The client is a fake that keeps its bucket in memory, but it has the S3
 * shape: get, put, delete, and a paginated list by prefix, plus the two
 * conditional writes S3 has had since 2024. `If-None-Match: *` creates a key
 * only while it's absent, and `If-Match: <etag>` replaces one only while it
 * hasn't changed. Those two writes are everything a claim needs. A claim is an
 * object holding its owner and expiry, and every change to it is a
 * conditional put against the ETag the claimer read, so when two claimers
 * race, the bucket accepts exactly one of them.
 *
 * A scope is a key prefix, which makes `clear` a paginated list and a delete
 * per key. Every name is percent-encoded before it joins a key, and values,
 * claims, and nested scopes each take a segment of their own, so two names
 * can't land on one object however alike they look.
 *
 * The example proves the store with `checkpoint_store_conformance` from
 * `fascicle/testing`, then drives an expense report through `durable` across
 * two events, each with its own client and driver over one bucket, the way
 * two processes would.
 *
 * Deterministic stub `fn` bodies: no engine layer, no network, no LLM calls.
 *
 * Run directly:
 *   pnpm exec tsx examples/object-store/main.ts
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  checkpoint,
  durable,
  sequence,
  step,
  suspend,
  type CheckpointStore,
  type DurableOutcome,
} from 'fascicle'
import { checkpoint_store_conformance } from 'fascicle/testing'

/**
 * An object as the bucket holds it.
 */
export type StoredObject = {
  readonly body: string
  readonly etag: string
}

/**
 * Everything the fake service keeps: the bucket's objects, by key.
 */
export type Bucket = Map<string, StoredObject>

/**
 * The condition on a put: create the key only while it's absent, or replace
 * it only while its ETag still matches.
 */
export type PutCondition = { readonly if_none_match: '*' } | { readonly if_match: string }

/**
 * One page of a listing. `next` is the key to start after for the next page,
 * present while more keys follow.
 */
export type ListPage = {
  readonly keys: ReadonlyArray<string>
  readonly next?: string
}

/**
 * The slice of an S3-style client that the store uses.
 */
export type ObjectClient = {
  readonly get: (key: string) => Promise<StoredObject | undefined>
  readonly put: (key: string, body: string, condition?: PutCondition) => Promise<void>
  readonly delete: (key: string) => Promise<void>
  readonly list: (prefix: string, start_after?: string) => Promise<ListPage>
}

/**
 * The store over a client: the whole `CheckpointStore` contract, scopes and
 * claims included.
 */
export type ObjectStore = {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
  readonly delete: (key: string) => Promise<void>
  readonly scope: (prefix: string) => ObjectScopedStore
  readonly claim: (key: string, owner: string, ttl_ms: number) => Promise<boolean>
  readonly release: (key: string, owner: string) => Promise<void>
}

/**
 * A scope of an `ObjectStore`, which can also `clear`.
 */
export type ObjectScopedStore = ObjectStore & {
  readonly clear: () => Promise<void>
}

type ClaimRecord = {
  readonly owner: string
  readonly expires_at: number
}

type Expense = {
  readonly employee: string
  readonly receipts: ReadonlyArray<number>
}

type Totaled = {
  readonly employee: string
  readonly total: number
}

type Decided = Totaled & {
  readonly approved: boolean
  readonly by: string
}

// Small on purpose, so a scope with more than a page of keys goes through the
// continuation that every real listing has.
const PAGE_SIZE = 4

// Values, claims, and nested scopes each take their own segment under a
// scope's prefix.
const VALUE = 'v/'
const CLAIM = 'c/'
const SCOPE = 's/'

const BASE = 'runs/'
const RUN_ID = 'exp-7'
const QUIET = { install_signal_handlers: false } as const

/**
 * Wait for the next turn of the event loop, the way a request waits on the
 * network, so concurrent callers interleave.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * True when a conditional put may go ahead against what the bucket holds.
 */
function condition_holds(condition: PutCondition, current: StoredObject | undefined): boolean {
  if ('if_none_match' in condition) return current === undefined
  return current?.etag === condition.if_match
}

/**
 * The error a failed condition throws. S3 answers it with a 412 and the error
 * code `PreconditionFailed`.
 */
function precondition_failed(key: string): Error {
  const err = new Error(`precondition failed for ${key}`)
  err.name = 'PreconditionFailed'
  return err
}

/**
 * An in-memory bucket behind the `ObjectClient` interface. Every call yields
 * once before it touches the bucket, so racing callers interleave, and a
 * conditional put checks and writes in one step, the way the service does.
 * Clients made over the same `bucket` see the same objects, like two
 * processes talking to one service.
 */
export function fake_object_client(bucket: Bucket = new Map()): ObjectClient {
  return {
    get: async (key) => {
      await tick()
      return bucket.get(key)
    },
    put: async (key, body, condition) => {
      await tick()
      if (condition !== undefined && !condition_holds(condition, bucket.get(key))) {
        throw precondition_failed(key)
      }
      bucket.set(key, { body, etag: randomUUID() })
    },
    delete: async (key) => {
      await tick()
      bucket.delete(key)
    },
    list: async (prefix, start_after = '') => {
      await tick()
      const keys = [...bucket.keys()].filter((key) => key.startsWith(prefix) && key > start_after).toSorted()
      const page = keys.slice(0, PAGE_SIZE)
      const last = page.at(-1)
      return keys.length > PAGE_SIZE && last !== undefined ? { keys: page, next: last } : { keys: page }
    },
  }
}

/**
 * Encode a key or a scope prefix as one segment of an object key. Percent
 * encoding leaves no `/` inside a name, so a value's key can never pass for
 * a nested scope's prefix, and dots are encoded too, because some HTTP layers
 * rewrite `.` and `..` segments in a path.
 */
function segment(name: string): string {
  return encodeURIComponent(name).replaceAll('.', '%2E')
}

/**
 * The object key that holds the value of `key` in the scope at `base`.
 */
function value_key(base: string, key: string): string {
  return `${base}${VALUE}${segment(key)}`
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
 * Put `body` under `key` if `condition` holds, resolving whether it did. A
 * failed condition means another writer got there first. A real bucket can
 * also answer 409 `ConditionalRequestConflict` while two conditional writes
 * overlap, and a store over one treats that the same way.
 */
async function put_if(client: ObjectClient, key: string, body: string, condition: PutCondition): Promise<boolean> {
  try {
    await client.put(key, body, condition)
    return true
  } catch (err) {
    if (err instanceof Error && err.name === 'PreconditionFailed') return false
    throw err
  }
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
async function claim_at(client: ObjectClient, key: string, owner: string, ttl_ms: number): Promise<boolean> {
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
 * The claim is overwritten as expired, on the ETag just read, rather than
 * deleted. A plain delete could erase a claim that another owner took after
 * the read, and the conditional put can't.
 */
async function release_at(client: ObjectClient, key: string, owner: string): Promise<void> {
  const current = await client.get(key)
  if (current === undefined || read_claim(current.body)?.owner !== owner) return
  await put_if(client, key, JSON.stringify({ owner, expires_at: 0 }), { if_match: current.etag })
}

/**
 * Delete every object whose key starts with `prefix`, a page at a time.
 */
async function delete_prefix(client: ObjectClient, prefix: string): Promise<void> {
  let start_after: string | undefined
  for (;;) {
    const page = await client.list(prefix, start_after)
    await Promise.all(page.keys.map((key) => client.delete(key)))
    if (page.next === undefined) return
    start_after = page.next
  }
}

/**
 * Build the store whose keys live under `base`, which ends in a slash.
 */
export function object_store(client: ObjectClient, base: string): ObjectStore {
  const claim_key = (key: string): string => `${base}${CLAIM}${segment(key)}`

  const scope = (prefix: string): ObjectScopedStore => {
    const dir = `${base}${SCOPE}${segment(prefix)}/`
    return { ...object_store(client, dir), clear: () => delete_prefix(client, dir) }
  }

  return {
    get: async (key) => {
      const object = await client.get(value_key(base, key))
      return object === undefined ? null : parse(object.body)
    },
    set: (key, value) => client.put(value_key(base, key), to_json(value)),
    delete: (key) => client.delete(value_key(base, key)),
    scope,
    claim: (key, owner, ttl_ms) => claim_at(client, claim_key(key), owner, ttl_ms),
    release: (key, owner) => release_at(client, claim_key(key), owner),
  }
}

/**
 * Overwrite the stored value of `key` with a torn body, the way a bad write
 * would leave it.
 */
export async function damage(client: ObjectClient, base: string, key: string): Promise<void> {
  await client.put(value_key(base, key), '{"torn')
}

/**
 * Build the expense flow. Each event builds it afresh, the way each process
 * would, and every build has the same shape, so the run accepts each one.
 */
export function build_expense() {
  return sequence(
    [
      checkpoint(
        step(
          'total',
          ({ employee, receipts }: Expense): Totaled => ({
            employee,
            total: receipts.reduce((sum, amount) => sum + amount, 0),
          }),
          { description: 'add up the receipts' },
        ),
        { key: 'total', description: 'keep the total in the bucket' },
      ),
      suspend({
        id: 'approve',
        description: 'wait for a manager to sign off',
        on: () => {
          // The manager's inbox would hear about it here.
        },
        resume_schema: z.object({ approved: z.boolean(), by: z.string() }),
        combine: (totaled: Totaled, decision): Decided => ({ ...totaled, ...decision }),
      }),
      step(
        'reimburse',
        (decided: Decided): string =>
          decided.approved
            ? `reimbursed ${decided.employee} ${decided.total.toFixed(2)}, approved by ${decided.by}`
            : `declined by ${decided.by}`,
        { description: 'pay the employee back', side_effect: true },
      ),
    ],
    { name: 'expense', description: 'reimburse an expense report once a manager approves it' },
  )
}

/**
 * A one-line account of an outcome.
 */
function describe_outcome(outcome: DurableOutcome<string>): string {
  if (outcome.kind === 'done') return `done: ${outcome.output}`
  if (outcome.kind === 'busy') return 'busy'
  return `waiting at ${outcome.id}`
}

/**
 * Check the store against the contract, each check over a fresh bucket, with
 * the damage check included.
 */
async function prove(): Promise<{
  readonly passed: number
  readonly failed: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<string>
}> {
  const clients = new WeakMap<CheckpointStore, ObjectClient>()
  const report = await checkpoint_store_conformance(
    () => {
      const client = fake_object_client()
      const store = object_store(client, BASE)
      clients.set(store, client)
      return store
    },
    {
      corrupt: async (store, key) => {
        const client = clients.get(store)
        if (client === undefined) throw new Error('corrupt was handed a store that make_store never built')
        await damage(client, BASE, key)
      },
    },
  )
  return {
    passed: report.passed.length,
    failed: report.failed.map(({ check, message }) => `${check}: ${message}`),
    skipped: report.skipped,
  }
}

export async function run_object_store(): Promise<{
  readonly conformance: Awaited<ReturnType<typeof prove>>
  readonly submitted: string
  readonly bucket_while_waiting: ReadonlyArray<string>
  readonly approved: string
  readonly deleted: boolean
  readonly bucket_after_delete: ReadonlyArray<string>
}> {
  const conformance = await prove()

  // One bucket outlives both events. Each event gets a client and a driver of
  // its own over it, standing in for a fresh process.
  const bucket: Bucket = new Map()
  const event = () => ({
    runs: durable({ store: object_store(fake_object_client(bucket), BASE) }),
    flow: build_expense(),
  })
  const keys = (): ReadonlyArray<string> => [...bucket.keys()].toSorted()

  const submit = event()
  const submitted = await submit.runs.start(RUN_ID, submit.flow, { employee: 'ada', receipts: [12.5, 30] }, QUIET)
  const bucket_while_waiting = keys()

  const approve = event()
  const approved = await approve.runs.resume(RUN_ID, approve.flow, { approve: { approved: true, by: 'grace' } }, QUIET)

  const deleted = await event().runs.delete(RUN_ID)

  return {
    conformance,
    submitted: describe_outcome(submitted),
    bucket_while_waiting,
    approved: describe_outcome(approved),
    deleted,
    bucket_after_delete: keys(),
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_object_store()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
