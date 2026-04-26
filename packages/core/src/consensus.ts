/**
 * consensus: run until agreement.
 *
 * `consensus({ members, agree, max_rounds })` runs every member concurrently
 * with the same input. If `agree(results)` is true, returns the results with
 * `converged: true`. Otherwise re-runs all members up to `max_rounds` times.
 * Returns the last result with `converged: false` if no agreement.
 *
 * Cancellation (constraints.md §5.1, spec.md §6.8): each member runs with a
 * composed abort signal. On abort the composer awaits in-flight members
 * before rethrowing `ctx.abort.reason`.
 *
 * See spec.md §5.13.
 */

import { aborted_error } from './errors.js';
import { dispatch_step, register_kind } from './runner.js';
import type { RunContext, Step } from './types.js';

type AnyStep = Step<unknown, unknown>;

export type ConsensusConfig<i, o> = {
  readonly members: Record<string, Step<i, o>>;
  readonly agree: (results: Record<string, o>) => boolean;
  readonly max_rounds: number;
};

export type ConsensusResult<o> = {
  readonly result: Record<string, o>;
  readonly converged: boolean;
};

let consensus_counter = 0;

function next_id(): string {
  consensus_counter += 1;
  return `consensus_${consensus_counter}`;
}

export function consensus<i, o>(config: ConsensusConfig<i, o>): Step<i, ConsensusResult<o>> {
  const id = next_id();
  const entries: ReadonlyArray<readonly [string, Step<i, o>]> = Object.entries(config.members);
  const child_list: ReadonlyArray<AnyStep> = entries.map(([, s]) => s);
  const keys: ReadonlyArray<string> = entries.map(([k]) => k);
  const agree_fn = config.agree;
  const rounds_limit = Math.max(1, Math.floor(config.max_rounds));

  const run_fn = async (input: i, ctx: RunContext): Promise<ConsensusResult<o>> => {
    let last_result: Record<string, o> = {};
    let round = 0;

    while (round < rounds_limit) {
      round += 1;
      if (ctx.abort.aborted) {
        const reason = ctx.abort.reason;
        throw reason instanceof Error ? reason : new aborted_error('aborted', { reason });
      }

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
          entries.map(async ([key, member], idx) => {
            const local = controllers[idx];
            if (!local) throw new Error('consensus: missing controller');
            const composed = AbortSignal.any([ctx.abort, local.signal]);
            const child_ctx: RunContext = { ...ctx, abort: composed };
            try {
              const value = await dispatch_step(member, input, child_ctx);
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

        const results: Record<string, o> = {};
        for (const s of settled) {
          if (s.status === 'ok') results[s.key] = s.value;
        }
        last_result = results;

        if (agree_fn(results)) {
          return { result: results, converged: true };
        }
      } finally {
        ctx.abort.removeEventListener('abort', on_parent_abort);
      }
    }

    return { result: last_result, converged: false };
  };

  return {
    id,
    kind: 'consensus',
    children: child_list,
    config: { keys, max_rounds: rounds_limit, agree: agree_fn },
    run: run_fn,
  };
}

register_kind('consensus', async (flow, input, ctx) => {
  const span_id = ctx.trajectory.start_span('consensus', { id: flow.id });
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
