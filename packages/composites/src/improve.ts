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
 * state, builds a round input, dispatches the proposers + scorer via
 * `ensemble_step`, and merges the outcome back into state via `use`.
 * State threading is the entire job.
 */

import { compose, loop, scope, step, stash, use } from '@repo/core';
import type { LoopResult, Step } from '@repo/core';
import { ensemble_step } from './ensemble_step.js';

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

  const proposers: Record<string, Step<ImproveRoundInput<c>, Candidate<c>>> = {};
  for (let i = 0; i < proposers_per_round; i += 1) {
    proposers[`p${String(i)}`] = propose;
  }

  const round_ensemble = ensemble_step<
    ImproveRoundInput<c>,
    Candidate<c>,
    ScoredCandidate<c>
  >({
    name: 'improve_round',
    members: proposers,
    score,
    rank_by: (s) => s.score,
  });

  type RoundResult = {
    readonly winner_id: string;
    readonly winner: Candidate<c>;
    readonly winner_scored: ScoredCandidate<c>;
    readonly scored: Record<string, ScoredCandidate<c>>;
  };

  const project_round = use(
    [PRIOR_KEY],
    (vars, ensemble_result: RoundResult, ctx): ScoredCandidate<c> => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const prior = vars[PRIOR_KEY] as ImproveState<c>;
      const round = prior.round + 1;
      for (const slot_id of Object.keys(ensemble_result.scored)) {
        const scored = ensemble_result.scored[slot_id];
        if (scored === undefined) continue;
        ctx.trajectory.record({
          kind: 'improve.candidate',
          round,
          proposer_id: slot_id,
          score: scored.score,
          accepted: scored.accepted,
          ...(scored.reason === undefined ? {} : { reason: scored.reason }),
        });
      }
      const w = ensemble_result.winner_scored;
      return {
        ...w,
        candidate: { ...w.candidate, proposer_id: ensemble_result.winner_id },
      };
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
    round_ensemble,
    project_round,
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
