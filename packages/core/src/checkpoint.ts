/**
 * checkpoint: persist and resume.
 *
 * `checkpoint(inner, { key })` checks a persistent store for a completed
 * result at `key` before running `inner`. On a hit, returns the stored
 * value. On a miss, runs `inner`, persists its result at `key`, and returns
 * it. Corrupted reads (store throws on `get`) are treated as a miss.
 *
 * Fail-fast (constraints.md §7 invariant 8, spec.md §9 F6): wrapping an
 * anonymous inner step throws synchronously at construction time with the
 * message `checkpoint requires a named step; got anonymous`.
 *
 * See spec.md §5.14, §6.3.
 */

import { dispatch_step, register_kind, resolve_span_label } from './runner.js'
import type { RunContext, Step } from './types.js'

export type CheckpointConfig<i> = {
  readonly name?: string
  readonly key: string | ((input: i) => string)
}

let checkpoint_counter = 0

function next_id(): string {
  checkpoint_counter += 1
  return `checkpoint_${checkpoint_counter}`
}

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

register_kind('checkpoint', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'checkpoint')
  const span_id = ctx.trajectory.start_span(label, { id: flow.id })
  try {
    const out = await flow.run(input, ctx)
    ctx.trajectory.end_span(span_id, { id: flow.id })
    return out
  } catch (err) {
    ctx.trajectory.end_span(span_id, {
      id: flow.id,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
})
