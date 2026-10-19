/**
 * checkpoint: persist and resume.
 *
 * `checkpoint(inner, { key })` checks a persistent store for a completed
 * result at `key` before running `inner`. On a hit, returns the stored
 * value. On a miss, runs `inner`, persists its result at `key`, and returns
 * it. Corrupted reads (store throws on `get`) are treated as a miss. Every
 * lookup records a `checkpoint` trajectory event with
 * `status: 'hit' | 'miss' | 'read_error'`.
 *
 * A failed write (store throws on `set`) doesn't fail the run either. It
 * records a `checkpoint` event with `status: 'write_error'` and returns the
 * inner result, because `inner` has already run and been paid for, and a
 * checkpoint is a cache, not the result. The next run with the same key
 * misses and runs `inner` again. `on_write_error: 'fail'` records the same
 * event and then throws the store's error, for a result that a `suspend`
 * hands to an approver, which has to be the one the store kept.
 *
 * Wrapping an anonymous inner step throws synchronously at construction time
 * with the message `checkpoint requires a named step, got anonymous`, because
 * a cached result must map back to a stable, identifiable step.
 *
 * A hit stands in for every `suspend` gate inside `inner` as well. Those gates
 * ran when the result was stored, so a resumed run that skips them has still
 * reached them, and the steps after the checkpoint aren't replays.
 */

import { description_meta } from './display_name.js'
import { dispatch_step, mark_gates_reached, register_traced_kind } from './runner.js'
import type { AnyStep, CheckpointStore, RunContext, Step, TrajectoryEvent } from './types.js'

export type CheckpointConfig<i> = {
  readonly name?: string
  readonly description?: string
  readonly key: string | ((input: i) => string)
  /**
   * What a failed `store.set` does. `'record'` (the default) records a
   * `write_error` event and returns the inner result. `'fail'` records the
   * same event and then throws the store's error, which is what a step whose
   * result a `suspend` hands to an approver wants, so the approval never
   * refers to a result that the store didn't keep.
   */
  readonly on_write_error?: 'record' | 'fail'
}

let checkpoint_counter = 0

/**
 * Generate a unique step id of the form `checkpoint_<n>`.
 */
function next_id(): string {
  checkpoint_counter += 1
  return `checkpoint_${checkpoint_counter}`
}

/**
 * The ids of every `suspend` gate in a step tree, the root included. `seen`
 * guards against a tree that reaches the same step twice.
 */
function gates_within(root: AnyStep, seen: Set<AnyStep> = new Set()): string[] {
  // Stryker disable next-line ArrayDeclaration: a step met a second time already had its gates counted, and a stray extra id names no gate, so it marks nothing.
  if (seen.has(root)) return []
  seen.add(root)
  // Stryker disable next-line ArrayDeclaration: a stray child seeded into a leaf is no suspend step and has no children of its own, so it adds no gate.
  const inner = (root.children ?? []).flatMap((child) => gates_within(child, seen))
  return root.kind === 'suspend' ? [root.id, ...inner] : inner
}

type EventMeta = Readonly<Record<string, unknown>>

/**
 * The fields every `checkpoint` event of one lookup carries: the step `id`,
 * the store `key`, and the `span_id` of the checkpoint's span when there is
 * one, so a viewer can nest the event.
 */
function event_meta(id: string, key: string, ctx: RunContext): EventMeta {
  const meta: Record<string, unknown> = { id, key }
  // Stryker disable next-line ConditionalExpression: the runner opens a span for every checkpoint it dispatches, so `parent_span_id` is always set here under `run`.
  if (ctx.parent_span_id !== undefined) meta['span_id'] = ctx.parent_span_id
  return meta
}

/**
 * The `checkpoint` event for a store call that threw, carrying its message.
 */
function store_failure(
  status: 'read_error' | 'write_error',
  err: unknown,
  meta: EventMeta,
): TrajectoryEvent {
  return {
    kind: 'checkpoint',
    status,
    error: err instanceof Error ? err.message : String(err),
    ...meta,
  }
}

/**
 * The value stored at `key` in `store`, or `undefined` on a miss, recording
 * exactly one `checkpoint` event so hits, misses, and swallowed read errors
 * are all visible in the trajectory. A stored `null` or `undefined` is a
 * miss, which is what lets `undefined` stand for one, and a throwing
 * `store.get` still behaves as a miss (a broken store must not fail the run),
 * but under `status: 'read_error'` instead of silently.
 */
async function look_up(
  store: CheckpointStore,
  key: string,
  meta: EventMeta,
  ctx: RunContext,
): Promise<unknown> {
  try {
    const value = await store.get(key)
    const hit = value !== null && value !== undefined
    ctx.trajectory.record({ kind: 'checkpoint', status: hit ? 'hit' : 'miss', ...meta })
    return hit ? value : undefined
  } catch (err) {
    ctx.trajectory.record(store_failure('read_error', err, meta))
    return undefined
  }
}

/**
 * Write `result` to `store` at `key`. A throwing `store.set` records
 * `status: 'write_error'` and leaves the result to the caller, since the
 * inner step that produced it has already run, unless `fail_on_write` says
 * to throw the store's error once the event is recorded.
 */
async function keep(
  store: CheckpointStore,
  key: string,
  result: unknown,
  meta: EventMeta,
  ctx: RunContext,
  fail_on_write: boolean,
): Promise<void> {
  try {
    await store.set(key, result)
  } catch (err) {
    ctx.trajectory.record(store_failure('write_error', err, meta))
    if (fail_on_write) throw err
  }
}

/**
 * Wrap `inner` with persist-and-resume behavior keyed by `config.key`.
 *
 * `key` is a fixed string or a function of the input. Without a
 * `checkpoint_store` on the run context, the wrapper runs `inner` directly.
 * A stored `null` or `undefined` counts as a miss, so those values are
 * re-computed rather than replayed. Throws at construction time when `inner`
 * is anonymous.
 */
export function checkpoint<i, o>(inner: Step<i, o>, config: CheckpointConfig<i>): Step<i, o> {
  if (inner.anonymous === true) {
    throw new Error(
      "checkpoint requires a named step, got anonymous — give the inner step an id with step('id', fn)",
    )
  }

  const id = next_id()
  const key_spec = config.key
  const fail_on_write = config.on_write_error === 'fail'
  const gates = gates_within(inner)

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    const key = typeof key_spec === 'function' ? key_spec(input) : key_spec
    const store = ctx.checkpoint_store
    if (!store) return dispatch_step(inner, input, ctx)

    const meta = event_meta(id, key, ctx)
    const cached = await look_up(store, key, meta, ctx)
    if (cached !== undefined) {
      mark_gates_reached(ctx, gates)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return cached as o
    }

    const result = await dispatch_step(inner, input, ctx)
    await keep(store, key, result, meta, ctx, fail_on_write)
    return result
  }

  const config_meta: Record<string, unknown> = { key: key_spec }
  if (config.name !== undefined) config_meta['display_name'] = config.name

  return {
    id,
    kind: 'checkpoint',
    children: [inner],
    config: config_meta,
    ...description_meta(config.description),
    run: run_fn,
  }
}

register_traced_kind('checkpoint')
