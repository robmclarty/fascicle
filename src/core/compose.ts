/**
 * compose: name a composite step.
 *
 * `compose(inner, { name })` wraps any step and labels its trajectory span
 * with `name`. The inner step's own span (for example, a `sequence`) appears
 * as a child of the compose span: the implementation tree is preserved while
 * the user's intent ("this whole thing is an ensemble") is surfaced in
 * observability.
 *
 * Used by the composites package to make built-in patterns appear under
 * their familiar names, and available to library consumers who want their own
 * named composites to show up in logs as first-class components.
 *
 * The primitive's `kind` is always `'compose'` and its id is `compose_<n>`.
 * The user-supplied label lives in `config.display_name`, is the span name
 * the dispatcher opens, and never reaches the id: it is free prose, so
 * folding it in would let a cosmetic rename move a trajectory id.
 */

import { dispatch_step, register_traced_kind } from './runner.js'
import type { RunContext, Step } from './types.js'

export type ComposeConfig = {
  readonly name: string
}

let compose_counter = 0

/**
 * Generate a unique step id of the form `compose_<n>`.
 */
function next_id(): string {
  compose_counter += 1
  return `compose_${compose_counter}`
}

/**
 * Wrap `inner` in a named composite step.
 *
 * The step's `kind` is always `'compose'`; `config.name` becomes the
 * `display_name` used as the span label. Throws a `TypeError` when `name`
 * is not a non-empty string, catching the mistake at construction time.
 */
export function compose<i, o>(inner: Step<i, o>, config: ComposeConfig): Step<i, o> {
  const name = config?.name
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('compose(inner, { name }): name must be a non-empty string')
  }
  const id = next_id()

  const run_fn = (input: i, ctx: RunContext): Promise<o> | o => dispatch_step(inner, input, ctx)

  return {
    id,
    kind: 'compose',
    children: [inner],
    config: { display_name: name },
    run: run_fn,
  }
}

register_traced_kind('compose')
