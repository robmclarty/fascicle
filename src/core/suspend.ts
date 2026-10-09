/**
 * suspend: human-in-the-loop pause.
 *
 * `suspend({ id, on, resume_schema, combine })` pauses a flow waiting on
 * external input (a notification, an approval, an uploaded file). On first
 * encounter with no resume data, it calls `on(input, ctx)` (side effect),
 * records a `suspended` trajectory event, and throws `suspended_error`
 * carrying the run state. On resume (re-invocation
 * with `run_options.resume_data[id]` populated), the provided value is
 * validated against `resume_schema` and passed to `combine(input, resume,
 * ctx)`; the result is returned. Invalid resume data throws
 * `resume_validation_error` carrying the vendor-neutral issue list.
 *
 * `deadline_ms` says how long the gate waits for its resume. The run can't
 * keep a clock of its own, since it unwinds as soon as it suspends, so the
 * value rides out on the `suspended_error` (and the outcome
 * `run.until_suspended` reports) for whoever drives the run to schedule a
 * timer that resumes the gate with whatever a timed-out resume means to it.
 */

import { validate_schema, type AnySchema } from '#schema'
import { description_meta } from './display_name.js'
import { resume_validation_error, suspended_error } from './errors.js'
import { is_step } from './is_step.js'
import { dispatch_step, mark_gates_reached, register_traced_kind } from './runner.js'
import type { RunContext, Step } from './types.js'

export type SuspendConfig<i, o, resume> = {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly deadline_ms?: number
  readonly on: (input: i, ctx: RunContext) => Promise<void> | void
  readonly resume_schema: AnySchema<resume>
  readonly combine: (
    input: i,
    resume: resume,
    ctx: RunContext,
  ) => Promise<o> | o | Step<i, o>
}

/**
 * The resume value addressed to `suspend_id`, read from the run's own resume
 * data only, so a gate named like an `Object.prototype` member (`toString`,
 * `constructor`) never mistakes the inherited member for a decision.
 */
function resume_value_for(ctx: RunContext, suspend_id: string): unknown {
  const resume_data = ctx.resume_data
  return resume_data !== undefined && Object.hasOwn(resume_data, suspend_id)
    ? resume_data[suspend_id]
    : undefined
}

/**
 * Build a human-in-the-loop pause step.
 *
 * First run fires the `on` side effect and throws `suspended_error`; a resume
 * run validates `resume_data[id]` against `resume_schema` and feeds it to
 * `combine`. The step's id is the user-supplied suspend id so resume data can
 * be addressed to it.
 */
export function suspend<i, o, resume>(config: SuspendConfig<i, o, resume>): Step<i, o> {
  const suspend_id = config.id
  const deadline_ms = config.deadline_ms
  const on_fn = config.on
  const resume_schema = config.resume_schema
  const combine_fn = config.combine

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    const resume_value = resume_value_for(ctx, suspend_id)
  
    if (resume_value === undefined) {
      await on_fn(input, ctx)
      // Mark the suspension on the wire before the throw, so a consumer sees
      // the gate pause as its own event ahead of the span-end error the
      // runner records for the escaping suspended_error. step_id is the
      // suspend step's id (the suspend id), the join key back to the
      // flow_structure node.
      ctx.trajectory.record({
        kind: 'suspended',
        suspend_id,
        step_id: suspend_id,
        ...(deadline_ms === undefined ? {} : { deadline_ms }),
      })
      throw new suspended_error(suspend_id, { input }, undefined, deadline_ms)
    }

    mark_gates_reached(ctx, [suspend_id])
    const parsed = await validate_schema(resume_schema, resume_value)
    if (!parsed.ok) {
      throw new resume_validation_error(
        `resume data for ${suspend_id} failed validation`,
        parsed.issues,
        suspend_id,
      )
    }

    const result = await combine_fn(input, parsed.value, ctx)
    if (is_step(result)) {
      return dispatch_step(result, input, ctx)
    }
    return result
  }

  const config_meta: Record<string, unknown> = { id: suspend_id }
  if (deadline_ms !== undefined) config_meta['deadline_ms'] = deadline_ms
  if (config.name !== undefined) config_meta['display_name'] = config.name

  return {
    id: suspend_id,
    kind: 'suspend',
    config: config_meta,
    ...description_meta(config.description),
    run: run_fn,
  }
}

register_traced_kind('suspend')
