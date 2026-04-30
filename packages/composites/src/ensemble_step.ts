/**
 * ensemble_step: N-of-M pick-best with a Step-based scorer.
 *
 * `ensemble_step({ members, score, rank_by, select? })` is the sibling of
 * `ensemble` for the case where scoring is itself a `Step` (e.g. a separate
 * model call, a sub-flow, anything that wants its own trajectory span and
 * abort routing). Each member runs concurrently with the same input; the
 * `score` step is dispatched once per result; `rank_by` projects a number
 * out of the structured scored output; the highest- or lowest-ranking
 * winner is returned alongside its full structured score and the score
 * map for the rest.
 *
 * Returning `winner_scored` avoids the cost of re-scoring the winner — the
 * structured output from the round's scoring run is preserved verbatim.
 *
 * Implemented as a `compose`d `scope` over (`stash(parallel(members))` →
 * `to_pairs` → `map(score per result, threading id)` → `use` to pick
 * winner). Cancellation, fan-out, and abort propagation come from the
 * underlying `parallel` and `map` contracts.
 */

import { compose, map, parallel, scope, stash, step, use } from '@repo/core';
import type { Step } from '@repo/core';

export type EnsembleStepConfig<i, o, ranked> = {
  readonly name?: string;
  readonly members: Record<string, Step<i, o>>;
  readonly score: Step<o, ranked>;
  readonly rank_by: (r: ranked) => number;
  readonly select?: 'max' | 'min';
};

export type EnsembleStepResult<o, ranked> = {
  readonly winner_id: string;
  readonly winner: o;
  readonly winner_scored: ranked;
  readonly scored: Record<string, ranked>;
};

const RESULTS_KEY = '__ensemble_step_results';
const ITEM_KEY = '__ensemble_step_item';

type Pair<o> = { readonly id: string; readonly value: o };
type ScoredPair<ranked> = { readonly id: string; readonly scored: ranked };

export function ensemble_step<i, o, ranked>(
  config: EnsembleStepConfig<i, o, ranked>,
): Step<i, EnsembleStepResult<o, ranked>> {
  const { members, score, rank_by } = config;
  const select: 'max' | 'min' = config.select ?? 'max';
  const keys = Object.keys(members);

  if (keys.length === 0) {
    throw new Error('ensemble_step: at least one member required');
  }

  const fan_out = parallel(members);

  const score_one = scope([
    stash(ITEM_KEY, step('ensemble_step_item_snapshot', (item: Pair<o>) => item)),
    step('ensemble_step_extract_value', (item: Pair<o>) => item.value),
    score,
    use([ITEM_KEY], (vars, scored: ranked): ScoredPair<ranked> => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const item = vars[ITEM_KEY] as Pair<o>;
      return { id: item.id, scored };
    }),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ]) as Step<Pair<o>, ScoredPair<ranked>>;

  const to_pairs = step(
    'ensemble_step_to_pairs',
    (results: Record<string, o>): ReadonlyArray<Pair<o>> => {
      const out: Pair<o>[] = [];
      for (const id of keys) {
        if (id in results) {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          out.push({ id, value: results[id] as o });
        }
      }
      return out;
    },
  );

  const score_each = map<ReadonlyArray<Pair<o>>, Pair<o>, ScoredPair<ranked>>({
    items: (pairs) => pairs,
    do: score_one,
  });

  const pick = use(
    [RESULTS_KEY],
    (vars, scored_pairs: ReadonlyArray<ScoredPair<ranked>>): EnsembleStepResult<o, ranked> => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const results = vars[RESULTS_KEY] as Record<string, o>;
      const scored: Record<string, ranked> = {};
      let winner_id: string | undefined;
      let winner_rank: number | undefined;
      let winner_scored: ranked | undefined;
      for (const pair of scored_pairs) {
        scored[pair.id] = pair.scored;
        const rank = rank_by(pair.scored);
        const better =
          winner_rank === undefined
            ? true
            : select === 'max'
              ? rank > winner_rank
              : rank < winner_rank;
        if (better) {
          winner_id = pair.id;
          winner_rank = rank;
          winner_scored = pair.scored;
        }
      }
      if (winner_id === undefined || winner_scored === undefined) {
        throw new Error('ensemble_step: no members produced a result');
      }
      const winner = results[winner_id];
      if (winner === undefined) {
        throw new Error('ensemble_step: winner missing from results');
      }
      return { winner_id, winner, winner_scored, scored };
    },
  );

  const inner = scope([
    stash(RESULTS_KEY, fan_out),
    to_pairs,
    score_each,
    pick,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ]) as Step<i, EnsembleStepResult<o, ranked>>;

  return compose(config.name ?? 'ensemble_step', inner);
}
