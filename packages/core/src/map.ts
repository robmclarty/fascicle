/**
 * map: per-item execution.
 *
 * `map({ items, do, concurrency? })` extracts an array via `items(input)`,
 * runs `do` once per element, returns an array in the same order as inputs.
 * `concurrency` caps simultaneous in-flight items; omitted means full
 * parallelism.
 *
 * Cancellation (constraints.md §5.1, spec.md §6.8): each in-flight item runs
 * with a composed abort signal via `AbortSignal.any([ctx.abort, child_local])`.
 * On abort no new items start. The composer awaits all in-flight items before
 * rethrowing `ctx.abort.reason`.
 */

import { aborted_error } from './errors.js';
import { dispatch_step, register_kind } from './runner.js';
import type { RunContext, Step } from './types.js';

export type MapConfig<input, item, result> = {
  readonly items: (input: input) => ReadonlyArray<item> | Promise<ReadonlyArray<item>>;
  readonly do: Step<item, result>;
  readonly concurrency?: number;
};

let map_counter = 0;

function next_id(): string {
  map_counter += 1;
  return `map_${map_counter}`;
}

export function map<input, item, result>(
  config: MapConfig<input, item, result>,
): Step<input, result[]> {
  const id = next_id();
  const { items, do: per_item, concurrency } = config;

  const run_fn = async (input: input, ctx: RunContext): Promise<result[]> => {
    const list = await items(input);
    if (list.length === 0) return [];
    const results: result[] = Array.from({ length: list.length });

    const limit = concurrency === undefined ? list.length : Math.max(1, concurrency);
    const controllers: AbortController[] = [];

    const on_parent_abort = (): void => {
      for (const c of controllers) c.abort(ctx.abort.reason);
    };
    if (ctx.abort.aborted) {
      on_parent_abort();
    } else {
      ctx.abort.addEventListener('abort', on_parent_abort, { once: true });
    }

    let cursor = 0;
    let worker_error: unknown = undefined;

    const run_one = async (idx: number): Promise<void> => {
      const local = new AbortController();
      controllers.push(local);
      const composed = AbortSignal.any([ctx.abort, local.signal]);
      const child_ctx: RunContext = { ...ctx, abort: composed };
      const item_value = list[idx];
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const value = await dispatch_step(per_item, item_value as item, child_ctx);
      results[idx] = value;
    };

    const worker = async (): Promise<void> => {
      while (true) {
        if (ctx.abort.aborted || worker_error !== undefined) return;
        const idx = cursor;
        cursor += 1;
        if (idx >= list.length) return;
        try {
          await run_one(idx);
        } catch (err) {
          if (worker_error === undefined) worker_error = err;
          return;
        }
      }
    };

    try {
      const worker_count = Math.min(limit, list.length);
      const workers: Promise<void>[] = [];
      for (let w = 0; w < worker_count; w += 1) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (ctx.abort.aborted) {
        const reason = ctx.abort.reason;
        throw reason instanceof Error ? reason : new aborted_error('aborted', { reason });
      }
      if (worker_error !== undefined) throw worker_error;

      return results;
    } finally {
      ctx.abort.removeEventListener('abort', on_parent_abort);
    }
  };

  return {
    id,
    kind: 'map',
    children: [per_item],
    ...(concurrency === undefined ? { config: { items } } : { config: { items, concurrency } }),
    run: run_fn,
  };
}

register_kind('map', async (flow, input, ctx) => {
  const span_id = ctx.trajectory.start_span('map', { id: flow.id });
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
