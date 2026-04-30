/**
 * improve: bounded online self-improvement loop.
 *
 * `improve({ seed, propose, score, budget })` runs a round-bounded loop that
 * threads a `parent` candidate through repeated propose → score → accept/reject
 * cycles. The kernel decides acceptance via a hard gate (`scored.accepted`) and
 * an epsilon-improvement test (`scored.score > parent_score + epsilon`).
 * Plateau detection stops the loop early when no progress has been made for
 * `patience` rounds; an optional wall-clock budget caps total runtime.
 *
 * `improve` is the *online* counterpart to `learn`: where `learn` reflects on
 * recorded trajectories offline, `improve` runs the propose/score loop live
 * inside a single run. The amplify example is a domain-specific consumer of
 * this same pattern (filesystem mutation, test-suite gates, subprocess
 * research). `improve` strips those opinions out so any domain can plug in
 * its own `propose` and `score` steps.
 *
 * Implemented as a `compose`d `scope` of (seed) → (init state) → (loop) →
 * (unwrap). The loop body is itself a small `scope` that snapshots prior
 * state, builds a round input, dispatches `propose` then `score`, and merges
 * the outcome back into state via `use`. State threading is the entire job.
 */

import { compose, loop, map, parallel, scope, step, stash, use } from '@repo/core';
import type { LoopResult, Step } from '@repo/core';

export type Candidate<c> = {
  readonly content: c;
  readonly proposer_id: string;
  readonly rationale?: string;
};

export type ScoredCandidate<c> = {
  readonly candidate: Candidate<c>;
  readonly score: number;
  readonly accepted: boolean;
  readonly reason?: string;
};

export type Lesson = {
  readonly round: number;
  readonly proposer_id: string;
  readonly reason: string;
};

export type ImproveRoundInput<c> = {
  readonly parent: c;
  readonly parent_score: number;
  readonly round: number;
  readonly lessons: ReadonlyArray<Lesson>;
};

export type ImproveBudget = {
  readonly max_rounds: number;
  readonly max_wallclock_ms?: number;
  readonly patience: number;
};

export type ImproveConfig<i, c> = {
  readonly name?: string;
  readonly seed: Step<i, { readonly content: c; readonly score: number }>;
  readonly propose: Step<ImproveRoundInput<c>, Candidate<c>>;
  readonly score: Step<Candidate<c>, ScoredCandidate<c>>;
  readonly budget: ImproveBudget;
  readonly epsilon?: number;
  readonly proposers_per_round?: number;
  readonly lessons_capacity?: number;
};

export type HistoryEntry<c> = {
  readonly round: number;
  readonly winner: ScoredCandidate<c>;
  readonly accepted: boolean;
};

export type ImproveResult<c> = {
  readonly best: { readonly content: c; readonly score: number };
  readonly rounds_used: number;
  readonly stopped_by: 'budget' | 'plateau';
  readonly history: ReadonlyArray<HistoryEntry<c>>;
};

const PRIOR_KEY = '__improve_prior';

type ImproveState<c> = {
  readonly parent: c;
  readonly parent_score: number;
  readonly round: number;
  readonly rounds_since_progress: number;
  readonly started_at_ms: number;
  readonly history: ReadonlyArray<HistoryEntry<c>>;
  readonly lessons: ReadonlyArray<Lesson>;
  readonly stopped_by?: 'budget' | 'plateau';
};

export function improve<i, c>(
  config: ImproveConfig<i, c>,
): Step<i, ImproveResult<c>> {
  const { seed, propose, score, budget } = config;
  const epsilon = config.epsilon ?? 0;
  const proposers_per_round = Math.max(1, config.proposers_per_round ?? 1);
  const lessons_capacity = Math.max(0, config.lessons_capacity ?? 5);
  const { max_rounds, max_wallclock_ms, patience } = budget;

  const proposer_ids: ReadonlyArray<string> = Array.from(
    { length: proposers_per_round },
    (_, i) => `p${i}`,
  );

  const proposers: Record<string, Step<ImproveRoundInput<c>, Candidate<c>>> = {};
  for (const id of proposer_ids) {
    proposers[id] = propose;
  }
  const fan_out_propose = parallel(proposers);

  const candidates_to_array = step(
    'improve_candidates_to_array',
    (record: Record<string, Candidate<c>>): ReadonlyArray<Candidate<c>> =>
      proposer_ids
        .map((id) => {
          const candidate = record[id];
          return candidate === undefined ? undefined : { ...candidate, proposer_id: id };
        })
        .filter((c0): c0 is Candidate<c> => c0 !== undefined),
  );

  const score_each = map<ReadonlyArray<Candidate<c>>, Candidate<c>, ScoredCandidate<c>>({
    items: (candidates) => candidates,
    do: score,
  });

  const pick_winner = use(
    [PRIOR_KEY],
    (vars, scored: ReadonlyArray<ScoredCandidate<c>>, ctx): ScoredCandidate<c> => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const prior = vars[PRIOR_KEY] as ImproveState<c>;
      const round = prior.round + 1;
      for (const s of scored) {
        ctx.trajectory.record({
          kind: 'improve.candidate',
          round,
          proposer_id: s.candidate.proposer_id,
          score: s.score,
          accepted: s.accepted,
          ...(s.reason === undefined ? {} : { reason: s.reason }),
        });
      }
      let winner: ScoredCandidate<c> | undefined;
      for (const s of scored) {
        if (winner === undefined || s.score > winner.score) winner = s;
      }
      if (winner === undefined) {
        throw new Error('improve: no candidates produced in round');
      }
      return winner;
    },
  );

  const init_state = step(
    'improve_init_state',
    (seed_result: { content: c; score: number }): ImproveState<c> => ({
      parent: seed_result.content,
      parent_score: seed_result.score,
      round: 0,
      rounds_since_progress: 0,
      started_at_ms: Date.now(),
      history: [],
      lessons: [],
    }),
  );

  const to_round_input = step(
    'improve_to_round_input',
    (s: ImproveState<c>, ctx): ImproveRoundInput<c> => {
      const round = s.round + 1;
      ctx.trajectory.record({
        kind: 'improve.round_start',
        round,
        parent_score: s.parent_score,
        lessons_count: s.lessons.length,
      });
      return {
        parent: s.parent,
        parent_score: s.parent_score,
        round,
        lessons: s.lessons,
      };
    },
  );

  const merge_outcome = use(
    [PRIOR_KEY],
    (vars, scored: ScoredCandidate<c>, ctx): ImproveState<c> => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const prior = vars[PRIOR_KEY] as ImproveState<c>;
      const next_round = prior.round + 1;
      const better = scored.score > prior.parent_score + epsilon;
      const accepted = scored.accepted && better;
      const next_lessons = !accepted && scored.reason !== undefined
        ? [
            ...prior.lessons,
            {
              round: next_round,
              proposer_id: scored.candidate.proposer_id,
              reason: scored.reason,
            },
          ].slice(-lessons_capacity)
        : prior.lessons;
      ctx.trajectory.record({
        kind: accepted ? 'improve.accept' : 'improve.reject',
        round: next_round,
        proposer_id: scored.candidate.proposer_id,
        score: scored.score,
        prior_score: prior.parent_score,
        ...(accepted ? { delta: scored.score - prior.parent_score } : {}),
        ...(scored.reason === undefined ? {} : { reason: scored.reason }),
      });
      return {
        parent: accepted ? scored.candidate.content : prior.parent,
        parent_score: accepted ? scored.score : prior.parent_score,
        round: next_round,
        rounds_since_progress: accepted ? 0 : prior.rounds_since_progress + 1,
        started_at_ms: prior.started_at_ms,
        history: [
          ...prior.history,
          { round: next_round, winner: scored, accepted },
        ],
        lessons: next_lessons,
      };
    },
  );

  const body = scope([
    stash(PRIOR_KEY, step('improve_snapshot', (s: ImproveState<c>) => s)),
    to_round_input,
    fan_out_propose,
    candidates_to_array,
    score_each,
    pick_winner,
    merge_outcome,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ]) as Step<ImproveState<c>, ImproveState<c>>;

  const guard = step(
    'improve_guard',
    (s: ImproveState<c>): { stop: boolean; state: ImproveState<c> } => {
      if (s.rounds_since_progress >= patience) {
        return { stop: true, state: { ...s, stopped_by: 'plateau' } };
      }
      if (
        max_wallclock_ms !== undefined &&
        Date.now() - s.started_at_ms >= max_wallclock_ms
      ) {
        return { stop: true, state: { ...s, stopped_by: 'budget' } };
      }
      return { stop: false, state: s };
    },
  );

  const round_loop = loop<ImproveState<c>, ImproveState<c>, ImproveResult<c>>({
    init: (s) => s,
    body,
    guard,
    finish: (s): ImproveResult<c> => ({
      best: { content: s.parent, score: s.parent_score },
      rounds_used: s.round,
      stopped_by: s.stopped_by ?? 'budget',
      history: s.history,
    }),
    max_rounds,
  });

  const unwrap = step(
    'improve_unwrap',
    (result: LoopResult<ImproveResult<c>>, ctx): ImproveResult<c> => {
      ctx.trajectory.record({
        kind: 'improve.stop',
        stopped_by: result.value.stopped_by,
        rounds_used: result.value.rounds_used,
        final_score: result.value.best.score,
      });
      return result.value;
    },
  );

  const inner = scope([
    seed,
    init_state,
    round_loop,
    unwrap,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ]) as Step<i, ImproveResult<c>>;

  return compose(config.name ?? 'improve', inner);
}
