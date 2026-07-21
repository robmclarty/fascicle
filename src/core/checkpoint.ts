/**
 * checkpoint: persist and resume.
 *
 * `checkpoint(inner, { key })` checks a persistent store for a completed
 * result at `key` before running `inner`. On a hit, returns the stored
 * value. On a miss, runs `inner`, persists its result at `key`, and returns
 * it. Corrupted reads (store throws on `get`) are treated as a miss.
 *
 * Wrapping an anonymous inner step throws synchronously at construction time
 * with the message `checkpoint requires a named step; got anonymous`, because
 * a cached result must map back to a stable, identifiable step.
 */

import { dispatch_step, register_traced_kind } from './runner.js'
import type { RunContext, Step } from './types.js'

export type CheckpointConfig<i> = {
  readonly name?: string
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
    throw new Error('checkpoint requires a named step; got anonymous')
  }

  const id = next_id()
  const key_spec = config.key

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    const key = typeof key_spec === 'function' ? key_spec(input) : key_spec
    const store = ctx.checkpoint_store
  
    if (store) {
      let cached: unknown = undefined
      let hit = false
      try {
        cached = await store.get(key)
        hit = cached !== null && cached !== undefined
      } catch {
        hit = false
      }
      if (hit) {
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
    run: run_fn,
  }
}

register_traced_kind('checkpoint')
