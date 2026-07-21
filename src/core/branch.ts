/**
 * branch: conditional routing.
 *
 * `branch({ when, then, otherwise })` evaluates `when(input)`; if truthy, runs
 * `then`, else runs `otherwise`. Both branches must return the same output
 * type.
 */

import { dispatch_step, register_traced_kind } from './runner.js'
import type { RunContext, Step } from './types.js'

export type BranchConfig<i, o> = {
  readonly name?: string
  readonly when: (input: i) => boolean | Promise<boolean>
  readonly then: Step<i, o>
  readonly otherwise: Step<i, o>
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
export function branch<i, o>(config: BranchConfig<i, o>): Step<i, o> {
  const id = next_id()
  const { when, then: then_step, otherwise: otherwise_step, name } = config

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    const cond = await when(input)
    const next_step = cond ? then_step : otherwise_step
    return dispatch_step(next_step, input, ctx)
  }

  const config_meta: Record<string, unknown> = { when, then: then_step, otherwise: otherwise_step }
  if (name !== undefined) config_meta['display_name'] = name

  return {
    id,
    kind: 'branch',
    children: [then_step, otherwise_step],
    config: config_meta,
    run: run_fn,
  }
}

register_traced_kind('branch')
