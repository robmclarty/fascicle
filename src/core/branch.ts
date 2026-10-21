/**
 * branch: conditional routing.
 *
 * `branch({ when, then, otherwise })` evaluates `when(input)`; if truthy, runs
 * `then`, else runs `otherwise`. The branch returns whichever arm ran, so its
 * output type is the union of the two arms' outputs, and naming one output
 * type, as in `branch<Pair, number | null>`, holds both arms to it.
 */

import { description_meta } from './display_name.js'
import { dispatch_step, register_traced_kind } from './runner.js'
import type { RunContext, Step } from './types.js'

// The otherwise arm's output defaults to the then arm's, so a config named
// with one output type holds both arms to it.
export type BranchConfig<i, o, otherwise_o = o> = {
  readonly name?: string
  readonly description?: string
  readonly when: (input: i) => boolean | Promise<boolean>
  readonly then: Step<i, o>
  readonly otherwise: Step<i, otherwise_o>
}

let branch_counter = 0

/**
 * Generate a unique step id of the form `branch_<n>`.
 */
function next_id(): string {
  branch_counter += 1
  return `branch_${branch_counter}`
}

/**
 * Build a conditional-routing step.
 *
 * Evaluates `when(input)` at run time and dispatches to `then` or `otherwise`.
 * Both branches appear as children so `describe()` renders the full tree even
 * though only one branch runs.
 */
export function branch<i, o, otherwise_o = o>(
  config: BranchConfig<i, o, otherwise_o>,
): Step<i, o | otherwise_o> {
  const id = next_id()
  const { when, then: then_step, otherwise: otherwise_step, name } = config

  const run_fn = async (input: i, ctx: RunContext): Promise<o | otherwise_o> => {
    const cond = await when(input)
    return cond ? dispatch_step(then_step, input, ctx) : dispatch_step(otherwise_step, input, ctx)
  }

  const config_meta: Record<string, unknown> = { when, then: then_step, otherwise: otherwise_step }
  if (name !== undefined) config_meta['display_name'] = name

  return {
    id,
    kind: 'branch',
    children: [then_step, otherwise_step],
    config: config_meta,
    ...description_meta(config.description),
    run: run_fn,
  }
}

register_traced_kind('branch')
