/**
 * step() factory.
 *
 * Three forms:
 *   step(id, fn):          named step. id is rendered in trajectory spans and describe().
 *   step(id, fn, options): named step carrying descriptive metadata. `name` is the
 *                          display channel: it labels the step's trajectory span and
 *                          its describe() line, leaving the id free to stay a stable
 *                          identifier. Nothing keys off it, so it is safe to reword.
 *                          `arm` declares the steps the body invokes via `ctx.call`.
 *   step(fn):              anonymous step. id is `step_<counter>`; cannot be checkpointed.
 *
 * Anonymous steps carry an internal `anonymous: true` flag so checkpoint can
 * reject them synchronously at flow construction time.
 *
 * An explicit id must be identifier-shaped: ids are read back as property
 * names wherever a step's output is bound (see step_id.ts). Free prose goes
 * in `meta.name`.
 */

import { is_step } from './is_step.js'
import { register_traced_kind } from './runner.js'
import { assert_valid_step_id } from './step_id.js'
import type { AnyStep, Step, StepFn, StepOptions } from './types.js'

let step_counter = 0

/**
 * Generate a unique id of the form `step_<n>` for anonymous steps.
 */
function next_step_id(): string {
  step_counter += 1
  return `step_${step_counter}`
}

/**
 * Normalize a declared arm (one step or several) to the children list.
 */
function arm_children(arm: AnyStep | ReadonlyArray<AnyStep>): ReadonlyArray<AnyStep> {
  return is_step(arm) ? [arm] : arm
}

/**
 * Wrap a plain function as a `Step`, named or anonymous.
 *
 * The named form takes an explicit id (identity) and optional `options`
 * (display, description, and declared arms); the anonymous form generates a
 * `step_<n>` id and marks the step so checkpoint rejects it at construction
 * time. Declared arms become the step's children, which is all `describe`
 * reads; the body alone decides whether and when they run. The rest of
 * `options` is stored as `meta`, and left off entirely when nothing remains,
 * so `describe` never echoes an empty object.
 */
export function step<i, o>(id: string, fn: StepFn<i, o>, options?: StepOptions): Step<i, o>
export function step<i, o>(fn: StepFn<i, o>): Step<i, o>
export function step<i, o>(
  id_or_fn: string | StepFn<i, o>,
  maybe_fn?: StepFn<i, o>,
  options?: StepOptions,
): Step<i, o> {
  if (typeof id_or_fn === 'function') {
    return {
      id: next_step_id(),
      kind: 'step',
      run: id_or_fn,
      anonymous: true,
    }
  }
  if (typeof maybe_fn !== 'function') {
    throw new TypeError('step(id, fn): fn must be a function')
  }
  assert_valid_step_id(id_or_fn, 'step id', 'put the label in meta.name')
  const { arm, ...meta }: StepOptions = options ?? {}
  return {
    id: id_or_fn,
    kind: 'step',
    run: maybe_fn,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    ...(arm === undefined ? {} : { children: arm_children(arm) }),
  }
}

register_traced_kind('step')
