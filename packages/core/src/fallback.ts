/**
 * fallback: primary-or-backup.
 *
 * `fallback(primary, backup)` runs `primary`. If it throws, runs `backup`
 * with the same input. If `backup` also throws, the `backup` error
 * propagates. See spec.md §5.8.
 */

import { dispatch_step, register_kind, resolve_span_label } from './runner.js';
import type { RunContext, Step } from './types.js';

let fallback_counter = 0;

function next_id(): string {
  fallback_counter += 1;
  return `fallback_${fallback_counter}`;
}

export type FallbackOptions = {
  readonly name?: string;
};

export function fallback<i, o>(
  primary: Step<i, o>,
  backup: Step<i, o>,
  options?: FallbackOptions,
): Step<i, o> {
  const id = next_id();

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    try {
      return await dispatch_step(primary, input, ctx);
    } catch {
      return dispatch_step(backup, input, ctx);
    }
  };

  const config_meta: Record<string, unknown> | undefined =
    options?.name === undefined ? undefined : { display_name: options.name };

  return {
    id,
    kind: 'fallback',
    children: [primary, backup],
    ...(config_meta ? { config: config_meta } : {}),
    run: run_fn,
  };
}

register_kind('fallback', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'fallback');
  const span_id = ctx.trajectory.start_span(label, { id: flow.id });
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
