/**
 * object-store: a durable run kept in a bucket, through `object_store` from
 * `fascicle/adapters`.
 *
 * `object_store` is a `CheckpointStore` over a small client interface, with
 * the scopes, the claims, and the conditional writes that `durable` needs.
 * The client here is a fake that keeps its bucket in memory, but it has the
 * S3 shape: get, put, delete, and a paginated list by prefix, plus the two
 * conditional writes S3 has had since 2024. `If-None-Match: *` creates a key
 * only while it's absent, and `If-Match: <etag>` replaces one only while it
 * hasn't changed. Those two writes are everything the store needs. A claim
 * is an object holding its owner and expiry, a run's record is an object
 * that every writer replaces on the ETag it read, and when two writers race,
 * the bucket accepts exactly one of them.
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
import { object_store, type ObjectClient, type ObjectPutCondition } from 'fascicle/adapters'
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

const PREFIX = 'runs/'
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
function condition_holds(condition: ObjectPutCondition, current: StoredObject | undefined): boolean {
  if ('if_none_match' in condition) return current === undefined
  return current?.etag === condition.if_match
}

/**
 * An in-memory bucket behind the `ObjectClient` interface. Every call yields
 * once before it touches the bucket, so racing callers interleave, and a
 * conditional put checks and writes in one step, the way the service does.
 * A put whose condition fails resolves false, which is how a real client
 * reports the service's 412. Clients made over the same `bucket` see the
 * same objects, like two processes talking to one service.
 */
export function fake_object_client(bucket: Bucket = new Map()): ObjectClient {
  return {
    get: async (key) => {
      await tick()
      return bucket.get(key)
    },
    put: async (key, body, condition) => {
      await tick()
      if (condition !== undefined && !condition_holds(condition, bucket.get(key))) return false
      bucket.set(key, { body, etag: randomUUID() })
      return true
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
 * Overwrite the stored value of `key` with a torn body, the way a bad write
 * would leave it. The store keeps a value at `<prefix>v/<name>`, with the
 * name percent-encoded.
 */
export async function damage(client: ObjectClient, key: string): Promise<void> {
  await client.put(`${PREFIX}v/${encodeURIComponent(key)}`, '{"torn')
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
      const store = object_store({ client, prefix: PREFIX })
      clients.set(store, client)
      return store
    },
    {
      corrupt: async (store, key) => {
        const client = clients.get(store)
        if (client === undefined) throw new Error('corrupt was handed a store that make_store never built')
        await damage(client, key)
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
    runs: durable({ store: object_store({ client: fake_object_client(bucket), prefix: PREFIX }) }),
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
