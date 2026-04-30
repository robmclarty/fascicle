/**
 * step() factory.
 *
 * Three forms:
 *   step(id, fn)       — named step. id is rendered in trajectory spans and describe().
 *   step(id, fn, meta) — named step with optional human-readable metadata for studio,
 *                        codegen, and similar consumers. `meta` is purely descriptive
 *                        and never affects runtime semantics.
 *   step(fn)           — anonymous step. id is `anon_<counter>`; cannot be checkpointed.
 *
 * Anonymous steps carry an internal `anonymous: true` flag so checkpoint can
 * reject them synchronously at flow construction time (spec.md §9 F6 / §7 invariant 8).
 */

import { register_kind } from './runner.js'
import type { RunContext, Step, StepFn, StepMetadata } from './types.js'

let anon_counter = 0

function next_anon_id(): string {
  anon_counter += 1
  return `anon_${anon_counter}`
}

export function step<i, o>(id: string, fn: StepFn<i, o>, meta?: StepMetadata): Step<i, o>
export function step<i, o>(fn: StepFn<i, o>): Step<i, o>
export function step<i, o>(
  id_or_fn: string | StepFn<i, o>,
  maybe_fn?: StepFn<i, o>,
  meta?: StepMetadata,
): Step<i, o> {
  if (typeof id_or_fn === 'function') {
    return {
      id: next_anon_id(),
      kind: 'step',
      run: id_or_fn,
      anonymous: true,
    }
  }
  if (typeof maybe_fn !== 'function') {
    throw new TypeError('step(id, fn): fn must be a function')
  }
  if (meta) {
    return {
      id: id_or_fn,
      kind: 'step',
      run: maybe_fn,
      meta,
    }
  }
  return {
    id: id_or_fn,
    kind: 'step',
    run: maybe_fn,
  }
}

register_kind('step', async (flow, input, ctx: RunContext): Promise<unknown> => {
  const span_id = ctx.trajectory.start_span('step', { id: flow.id })
  try {
    const output = await flow.run(input, ctx)
    ctx.trajectory.end_span(span_id, { id: flow.id })
    return output
  } catch (err) {
    ctx.trajectory.end_span(span_id, {
      id: flow.id,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
})
