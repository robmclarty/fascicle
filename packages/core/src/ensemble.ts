/**
 * ensemble: N-of-M pick best.
 *
 * `ensemble({ members, score, select? })` runs every member concurrently with
 * the same input, scores each result, and returns the winner (highest or
 * lowest by `select`) plus the complete score map. Tie-breaking is defined
 * as "any tied result is acceptable".
 *
 * Cancellation (constraints.md §5.1, spec.md §6.8): each member runs with a
 * composed abort signal via `AbortSignal.any([ctx.abort, child_local])`. On
 * abort the composer awaits all in-flight members before rethrowing
 * `ctx.abort.reason`.
 *
 * See spec.md §5.11.
 */

import { aborted_error } from './errors.js';
import { dispatch_step, register_kind } from './runner.js';
import type { RunContext, Step } from './types.js';

type AnyStep = Step<unknown, unknown>;

export type EnsembleConfig<i, o> = {
  readonly members: Record<string, Step<i, o>>;
  readonly score: (result: o, member_id: string) => number | Promise<number>;
  readonly select?: 'max' | 'min';
};

export type EnsembleResult<o> = {
  readonly winner: o;
  readonly scores: Record<string, number>;
};

let ensemble_counter = 0;

function next_id(): string {
  ensemble_counter += 1;
  return `ensemble_${ensemble_counter}`;
}

export function ensemble<i, o>(config: EnsembleConfig<i, o>): Step<i, EnsembleResult<o>> {
  const id = next_id();
  const entries: ReadonlyArray<readonly [string, Step<i, o>]> = Object.entries(config.members);
  const child_list: ReadonlyArray<AnyStep> = entries.map(([, s]) => s);
  const keys: ReadonlyArray<string> = entries.map(([k]) => k);
  const score_fn = config.score;
  const select: 'max' | 'min' = config.select ?? 'max';

  const run_fn = async (input: i, ctx: RunContext): Promise<EnsembleResult<o>> => {
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
          if (!local) throw new Error('ensemble: missing controller');
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

      const scores: Record<string, number> = {};
      const results: Record<string, o> = {};
      for (const s of settled) {
        if (s.status === 'ok') {
          results[s.key] = s.value;
          scores[s.key] = await score_fn(s.value, s.key);
        }
      }

      let winner_key: string | undefined = undefined;
      let winner_score: number | undefined = undefined;
      for (const k of keys) {
        const current = scores[k];
        if (current === undefined) continue;
        if (winner_score === undefined) {
          winner_key = k;
          winner_score = current;
          continue;
        }
        const better = select === 'max' ? current > winner_score : current < winner_score;
        if (better) {
          winner_key = k;
          winner_score = current;
        }
      }

      if (winner_key === undefined) {
        throw new Error('ensemble: no members produced a result');
      }
      const winner = results[winner_key];
      if (winner === undefined) {
        throw new Error('ensemble: winner missing from results');
      }
      return { winner, scores };
    } finally {
      ctx.abort.removeEventListener('abort', on_parent_abort);
    }
  };

  return {
    id,
    kind: 'ensemble',
    children: child_list,
    config: { keys, select },
    run: run_fn,
  };
}

register_kind('ensemble', async (flow, input, ctx) => {
  const span_id = ctx.trajectory.start_span('ensemble', { id: flow.id });
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
