/**
 * suspend: human-in-the-loop pause.
 *
 * `suspend({ id, on, resume_schema, combine })` pauses a flow waiting on
 * external input (a notification, an approval, an uploaded file). On first
 * encounter with no resume data, it calls `on(input, ctx)` (side effect) and
 * throws `suspended_error` carrying the run state. On resume (re-invocation
 * with `run_options.resume_data[id]` populated), the provided value is
 * validated against `resume_schema` and passed to `combine(input, resume,
 * ctx)`; the result is returned. Invalid resume data throws
 * `resume_validation_error` built from zod 4's `.flatten()` (spec.md §9 F5).
 *
 * See spec.md §5.15, §6.4.
 */

import { z } from 'zod';
import { resume_validation_error, suspended_error } from './errors.js';
import { dispatch_step, register_kind } from './runner.js';
import type { RunContext, Step } from './types.js';

export type SuspendConfig<i, o, resume> = {
  readonly id: string;
  readonly on: (input: i, ctx: RunContext) => Promise<void> | void;
  readonly resume_schema: z.ZodType<resume>;
  readonly combine: (
    input: i,
    resume: resume,
    ctx: RunContext,
  ) => Promise<o> | o | Step<unknown, o>;
};

function is_step(value: unknown): value is Step<unknown, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || !('kind' in value) || !('run' in value)) return false;
  const { id, kind, run } = value as { id: unknown; kind: unknown; run: unknown };
  return typeof id === 'string' && typeof kind === 'string' && typeof run === 'function';
}

export function suspend<i, o, resume>(config: SuspendConfig<i, o, resume>): Step<i, o> {
  const suspend_id = config.id;
  const on_fn = config.on;
  const resume_schema = config.resume_schema;
  const combine_fn = config.combine;

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    const resume_value = ctx.resume_data?.[suspend_id];

    if (resume_value === undefined) {
      await on_fn(input, ctx);
      throw new suspended_error(suspend_id, { input });
    }

    const parsed = resume_schema.safeParse(resume_value);
    if (!parsed.success) {
      const issues = z.flattenError(parsed.error);
      throw new resume_validation_error(
        `resume data for ${suspend_id} failed validation`,
        issues,
      );
    }

    const result = await combine_fn(input, parsed.data, ctx);
    if (is_step(result)) {
      return dispatch_step(result, input, ctx);
    }
    return result;
  };

  return {
    id: suspend_id,
    kind: 'suspend',
    config: { id: suspend_id },
    run: run_fn,
  };
}

register_kind('suspend', async (flow, input, ctx) => {
  const span_id = ctx.trajectory.start_span('suspend', { id: flow.id });
  try {
    const out = await flow.run(input, ctx);
    ctx.trajectory.end_span(span_id, { id: flow.id });
    return out;
  } catch (err) {
    ctx.trajectory.end_span(span_id, {
      id: flow.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
});
