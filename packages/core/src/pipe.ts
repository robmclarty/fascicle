/**
 * pipe: transform output.
 *
 * `pipe(inner, fn)` runs `inner`, passes its output to `fn`, returns `fn`'s
 * result. Use for shape adaptation when composing heterogeneous steps.
 *
 * See spec.md §5.6.
 */

import { dispatch_step, register_kind, resolve_span_label } from './runner.js';
import type { RunContext, Step } from './types.js';

let pipe_counter = 0;

function next_id(): string {
  pipe_counter += 1;
  return `pipe_${pipe_counter}`;
}

export type PipeOptions = {
  readonly name?: string;
};

export function pipe<i, a, b>(
  inner: Step<i, a>,
  fn: (value: a) => b | Promise<b>,
  options?: PipeOptions,
): Step<i, b> {
  const id = next_id();

  const run_fn = async (input: i, ctx: RunContext): Promise<b> => {
    const intermediate = await dispatch_step(inner, input, ctx);
    return fn(intermediate);
  };

  const config_meta: Record<string, unknown> = { fn };
  if (options?.name !== undefined) config_meta['display_name'] = options.name;

  return {
    id,
    kind: 'pipe',
    children: [inner],
    config: config_meta,
    run: run_fn,
  };
}

register_kind('pipe', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'pipe');
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
