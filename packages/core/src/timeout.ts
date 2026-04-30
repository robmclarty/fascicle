/**
 * timeout: bound execution.
 *
 * `timeout(inner, ms)` runs `inner` with a composed `AbortSignal` that fires
 * at `ms` milliseconds. If the inner step does not complete in time, throws
 * `timeout_error`. The inner step is responsible for honoring `ctx.abort`;
 * a step that ignores the signal still triggers `timeout_error` on schedule
 * but continues running in the background (spec.md §9 F4).
 *
 * Cancellation (constraints.md §5.1, spec.md §6.8): the inner step runs with
 * `AbortSignal.any([ctx.abort, timeout_local])`. On timer expiry, the local
 * controller aborts with a `timeout_error` as its reason; on parent abort
 * the parent reason flows through. The timer is always cleared in a finally
 * block so it does not leak across retries.
 */

import { aborted_error, timeout_error } from './errors.js';
import { dispatch_step, register_kind, resolve_span_label } from './runner.js';
import type { RunContext, Step } from './types.js';

let timeout_counter = 0;

function next_id(): string {
  timeout_counter += 1;
  return `timeout_${timeout_counter}`;
}

export type TimeoutOptions = {
  readonly name?: string;
};

export function timeout<i, o>(
  inner: Step<i, o>,
  ms: number,
  options?: TimeoutOptions,
): Step<i, o> {
  const id = next_id();

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    const local = new AbortController();
    const composed = AbortSignal.any([ctx.abort, local.signal]);
    const child_ctx: RunContext = { ...ctx, abort: composed };

    let timed_out = false;
    const timer = setTimeout(() => {
      timed_out = true;
      local.abort(new timeout_error(`timeout after ${ms}ms`, ms));
    }, ms);

    const deadline = new Promise<never>((_, reject) => {
      const on_local_abort = (): void => {
        if (timed_out) {
          reject(new timeout_error(`timeout after ${ms}ms`, ms));
        } else {
          const reason = ctx.abort.reason;
          reject(reason instanceof Error ? reason : new aborted_error('aborted', { reason }));
        }
      };
      if (composed.aborted) {
        on_local_abort();
        return;
      }
      composed.addEventListener('abort', on_local_abort, { once: true });
    });

    try {
      return await Promise.race([dispatch_step(inner, input, child_ctx), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  const config_meta: Record<string, unknown> = { ms };
  if (options?.name !== undefined) config_meta['display_name'] = options.name;

  return {
    id,
    kind: 'timeout',
    children: [inner],
    config: config_meta,
    run: run_fn,
  };
}

register_kind('timeout', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'timeout');
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
