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
import type { AnyStep, RunContext, Step } from './types.js'

export type CheckpointConfig<i> = {
  readonly name?: string
  readonly description?: string
  readonly key: string | ((input: i) => string)
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
  const gates = gates_within(inner)

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    const key = typeof key_spec === 'function' ? key_spec(input) : key_spec
    const store = ctx.checkpoint_store

    if (store) {
      let cached: unknown = undefined
      let hit = false
      // Every lookup records exactly one `checkpoint` event so hits, misses,
      // and swallowed read errors are all visible in the trajectory. A
      // throwing `store.get` still behaves as a miss (a broken store must not
      // fail the run), but under `status: 'read_error'` instead of silently.
      const lookup_meta: Record<string, unknown> = { id, key }
      if (ctx.parent_span_id !== undefined) lookup_meta['span_id'] = ctx.parent_span_id
      try {
        cached = await store.get(key)
        hit = cached !== null && cached !== undefined
        ctx.trajectory.record({
          kind: 'checkpoint',
          status: hit ? 'hit' : 'miss',
          ...lookup_meta,
        })
      } catch (err) {
        hit = false
        ctx.trajectory.record({
          kind: 'checkpoint',
          status: 'read_error',
          error: err instanceof Error ? err.message : String(err),
          ...lookup_meta,
        })
      }
      if (hit) {
        mark_gates_reached(ctx, gates)
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return cached as o
      }
    }
  
    const result = await dispatch_step(inner, input, ctx)
  
    if (store) {
      await store.set(key, result)
    }
  
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
