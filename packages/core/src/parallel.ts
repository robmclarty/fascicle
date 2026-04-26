/**
 * parallel: concurrent execution of named children.
 *
 * `parallel({ a, b })` runs a and b concurrently with the same input. Output
 * is an object keyed by the child name; all children must accept the same
 * input type.
 *
 * Cancellation (constraints.md §5.1, spec.md §6.8): each child runs with a
 * composed abort signal — `AbortSignal.any([ctx.abort, child_local])`. On
 * abort the composer awaits all in-flight children (success, failure, or
 * aborted) before rethrowing `ctx.abort.reason`. This matches the
 * "agent-pattern" composer contract in spec.md §6.8.
 */

import { aborted_error } from './errors.js';
import { dispatch_step, register_kind } from './runner.js';
import type { RunContext, Step } from './types.js';

type AnyStep = Step<unknown, unknown>;

type OutputOf<s> = s extends Step<unknown, infer o> ? o : unknown;

type ParallelOutputs<children extends Record<string, AnyStep>> = {
  [k in keyof children]: OutputOf<children[k]>;
};

let parallel_counter = 0;

function next_id(): string {
  parallel_counter += 1;
  return `parallel_${parallel_counter}`;
}

export function parallel<i, children extends Record<string, Step<i, unknown>>>(
  members: children,
): Step<i, ParallelOutputs<children>> {
  const id = next_id();
  const entries: ReadonlyArray<readonly [string, AnyStep]> = Object.entries(members);
  const child_list: ReadonlyArray<AnyStep> = entries.map(([, s]) => s);
  const keys: ReadonlyArray<string> = entries.map(([k]) => k);

  const run_fn = async (input: i, ctx: RunContext): Promise<ParallelOutputs<children>> => {
    const controllers = entries.map(() => new AbortController());
    const on_parent_abort = (): void => {
      for (const c of controllers) c.abort(ctx.abort.reason);
    };
    if (ctx.abort.aborted) {
      on_parent_abort();
    } else {
      ctx.abort.addEventListener('abort', on_parent_abort, { once: true });
    }

    try {
      const settled = await Promise.all(
        entries.map(async ([key, child], idx) => {
          const local = controllers[idx];
          if (!local) throw new Error('parallel: missing controller');
          const composed = AbortSignal.any([ctx.abort, local.signal]);
          const child_ctx: RunContext = { ...ctx, abort: composed };
          try {
            const value = await dispatch_step(child, input, child_ctx);
            return { status: 'ok' as const, key, value };
          } catch (err) {
            return { status: 'err' as const, key, err };
          }
        }),
      );

      if (ctx.abort.aborted) {
        const reason = ctx.abort.reason;
        throw reason instanceof Error ? reason : new aborted_error('aborted', { reason });
      }

      for (const s of settled) {
        if (s.status === 'err') throw s.err;
      }

      const out: Record<string, unknown> = {};
      for (const s of settled) {
        if (s.status === 'ok') out[s.key] = s.value;
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return out as ParallelOutputs<children>;
    } finally {
      ctx.abort.removeEventListener('abort', on_parent_abort);
    }
  };

  return {
    id,
    kind: 'parallel',
    children: child_list,
    config: { keys },
    run: run_fn,
  };
}

register_kind('parallel', async (flow, input, ctx) => {
  const span_id = ctx.trajectory.start_span('parallel', { id: flow.id });
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
