/**
 * tournament: pairwise bracket.
 *
 * `tournament({ members, compare })` runs every member, then pairs them off
 * in a single-elimination bracket. `compare(a, b)` returns which result
 * advances. An odd member count yields one bye per affected round. The
 * returned `bracket` is a list of `{ round, a_id, b_id, winner_id }`.
 *
 * Cancellation (constraints.md §5.1, spec.md §6.8): each member runs with a
 * composed abort signal. On abort the composer awaits in-flight members
 * before rethrowing `ctx.abort.reason`.
 *
 * See spec.md §5.12.
 */

import { aborted_error } from './errors.js';
import { dispatch_step, register_kind } from './runner.js';
import type { RunContext, Step } from './types.js';

type AnyStep = Step<unknown, unknown>;

export type BracketRecord = {
  readonly round: number;
  readonly a_id: string;
  readonly b_id: string;
  readonly winner_id: string;
};

export type TournamentConfig<i, o> = {
  readonly members: Record<string, Step<i, o>>;
  readonly compare: (a: o, b: o) => Promise<'a' | 'b'> | 'a' | 'b';
};

export type TournamentResult<o> = {
  readonly winner: o;
  readonly bracket: ReadonlyArray<BracketRecord>;
};

let tournament_counter = 0;

function next_id(): string {
  tournament_counter += 1;
  return `tournament_${tournament_counter}`;
}

export function tournament<i, o>(config: TournamentConfig<i, o>): Step<i, TournamentResult<o>> {
  const id = next_id();
  const entries: ReadonlyArray<readonly [string, Step<i, o>]> = Object.entries(config.members);
  const child_list: ReadonlyArray<AnyStep> = entries.map(([, s]) => s);
  const keys: ReadonlyArray<string> = entries.map(([k]) => k);
  const compare_fn = config.compare;

  const run_fn = async (input: i, ctx: RunContext): Promise<TournamentResult<o>> => {
    if (entries.length === 0) {
      throw new Error('tournament: at least one member required');
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
          if (!local) throw new Error('tournament: missing controller');
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

      const results = new Map<string, o>();
      for (const s of settled) {
        if (s.status === 'ok') results.set(s.key, s.value);
      }

      let current: string[] = [...keys];
      const bracket: BracketRecord[] = [];
      let round = 0;

      while (current.length > 1) {
        round += 1;
        const next_round: string[] = [];
        for (let i = 0; i < current.length; i += 2) {
          const a_id = current[i];
          const b_id = current[i + 1];
          if (a_id === undefined) continue;
          if (b_id === undefined) {
            next_round.push(a_id);
            continue;
          }
          const a_val = results.get(a_id);
          const b_val = results.get(b_id);
          if (a_val === undefined || b_val === undefined) {
            throw new Error('tournament: missing result for match');
          }
          const pick = await compare_fn(a_val, b_val);
          const winner_id = pick === 'a' ? a_id : b_id;
          bracket.push({ round, a_id, b_id, winner_id });
          next_round.push(winner_id);
        }
        current = next_round;
      }

      const final_id = current[0];
      if (final_id === undefined) {
        throw new Error('tournament: no winner');
      }
      const winner = results.get(final_id);
      if (winner === undefined) {
        throw new Error('tournament: winner missing from results');
      }
      return { winner, bracket };
    } finally {
      ctx.abort.removeEventListener('abort', on_parent_abort);
    }
  };

  return {
    id,
    kind: 'tournament',
    children: child_list,
    config: { keys },
    run: run_fn,
  };
}

register_kind('tournament', async (flow, input, ctx) => {
  const span_id = ctx.trajectory.start_span('tournament', { id: flow.id });
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
