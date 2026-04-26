/**
 * pipe: transform output.
 *
 * `pipe(inner, fn)` runs `inner`, passes its output to `fn`, returns `fn`'s
 * result. Use for shape adaptation when composing heterogeneous steps.
 *
 * See spec.md §5.6.
 */

import { dispatch_step, register_kind } from './runner.js';
import type { RunContext, Step } from './types.js';

let pipe_counter = 0;

function next_id(): string {
  pipe_counter += 1;
  return `pipe_${pipe_counter}`;
}

export function pipe<i, a, b>(
  inner: Step<i, a>,
  fn: (value: a) => b | Promise<b>,
): Step<i, b> {
  const id = next_id();

  const run_fn = async (input: i, ctx: RunContext): Promise<b> => {
    const intermediate = await dispatch_step(inner, input, ctx);
    return fn(intermediate);
  };

  return {
    id,
    kind: 'pipe',
    children: [inner],
    config: { fn },
    run: run_fn,
  };
}

register_kind('pipe', async (flow, input, ctx) => {
  const span_id = ctx.trajectory.start_span('pipe', { id: flow.id });
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
