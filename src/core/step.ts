/**
 * step() factory.
 *
 * Three forms:
 *   step(id, fn):       named step. id is rendered in trajectory spans and describe().
 *   step(id, fn, meta): named step carrying descriptive metadata. `meta.name` is the
 *                       display channel: it labels the step's trajectory span and its
 *                       describe() line, leaving the id free to stay a stable
 *                       identifier. Nothing keys off it, so it is safe to reword.
 *   step(fn):           anonymous step. id is `step_<counter>`; cannot be checkpointed.
 *
 * Anonymous steps carry an internal `anonymous: true` flag so checkpoint can
 * reject them synchronously at flow construction time.
 *
 * An explicit id must be identifier-shaped: ids are read back as property
 * names wherever a step's output is bound (see step_id.ts). Free prose goes
 * in `meta.name`.
 */

import { register_traced_kind } from './runner.js'
import { assert_valid_step_id } from './step_id.js'
import type { Step, StepFn, StepMetadata } from './types.js'

let step_counter = 0

/**
 * Generate a unique id of the form `step_<n>` for anonymous steps.
 */
function next_step_id(): string {
  step_counter += 1
  return `step_${step_counter}`
}

/**
 * Wrap a plain function as a `Step`, named or anonymous.
 *
 * The named form takes an explicit id (identity) and optional `meta` (display
 * and description); the anonymous form generates a `step_<n>` id and marks the
 * step so checkpoint rejects it at construction time.
 */
export function step<i, o>(id: string, fn: StepFn<i, o>, meta?: StepMetadata): Step<i, o>
export function step<i, o>(fn: StepFn<i, o>): Step<i, o>
export function step<i, o>(
  id_or_fn: string | StepFn<i, o>,
  maybe_fn?: StepFn<i, o>,
  meta?: StepMetadata,
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

register_traced_kind('step')
