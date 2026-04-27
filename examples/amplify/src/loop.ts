/**
 * The amplify loop.
 *
 *   scope([
 *     stash(BRIEF, ...),       // user input
 *     stash(BASELINE, ...),    // score the starter
 *     stash(RESEARCH, ...),    // one-shot online research
 *     round_loop,              // ensemble per round, bounded by budget+plateau
 *   ])
 *
 * Each round:
 *   1. Build N propose steps in parallel via `ensemble`
 *   2. Score each candidate sequentially in `score` (fs-isolated swap-in/restore)
 *   3. Pick winner. If it beats parent by epsilon, accept; else accumulate a lesson.
 *   4. Stop on budget exhaustion or plateau.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ensemble,
  scope,
  stash,
  step,
  type Engine,
  type RunContext,
  type Step,
} from '@repo/fascicle';

import { archive_candidate, commit_parent } from './apply.js';
import { make_budget, type BudgetConfig } from './budget.js';
import { evaluate_candidate, failure_score_for } from './evaluate.js';
import { make_lessons } from './lessons.js';
import { build_propose_step } from './propose.js';
import { cache_research, gather_research, pick_mode } from './research.js';
import type { Brief, Candidate, CandidateSpec } from './types.js';

const STASH_BRIEF = 'brief';
const STASH_BASELINE = 'baseline';
const STASH_RESEARCH = 'research';

const EPSILON = 0.001;
const LESSONS_CAPACITY = 5;

export type LoopConfig = {
  readonly engine: Engine;
  readonly candidates_per_round: number;
  readonly budget: BudgetConfig;
};

function read_brief(state: ReadonlyMap<string, unknown>): Brief {
  const v = state.get(STASH_BRIEF);
  if (v === undefined) throw new Error(`amplify: scope state missing key "${STASH_BRIEF}"`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return v as Brief;
}

function read_baseline(state: ReadonlyMap<string, unknown>): number {
  const v = state.get(STASH_BASELINE);
  if (typeof v !== 'number') {
    throw new Error(`amplify: scope state key "${STASH_BASELINE}" is not a number`);
  }
  return v;
}

function read_research(state: ReadonlyMap<string, unknown>): string {
  const v = state.get(STASH_RESEARCH);
  if (typeof v !== 'string') {
    throw new Error(`amplify: scope state key "${STASH_RESEARCH}" is not a string`);
  }
  return v;
}

function strictly_better(direction: 'minimize' | 'maximize', a: number, b: number): boolean {
  return direction === 'minimize' ? a < b - EPSILON : a > b + EPSILON;
}

function summarize_candidate(c: Candidate): string {
  if (c.score.accepted) {
    return `score=${String(c.score.value)}; rationale: ${c.spec.rationale}`;
  }
  return `failed at ${String(c.score.stage_failed)}; rationale: ${c.spec.rationale}`;
}

export function build_loop(config: LoopConfig): Step<Brief, undefined> {
  const round_loop = build_round_loop_step(config);
  const flow: Step<unknown, undefined> = scope([
    stash(STASH_BRIEF, step('init_brief', (b: Brief) => b)),
    stash(STASH_BASELINE, build_baseline_step()),
    stash(STASH_RESEARCH, build_research_step(config.engine)),
    round_loop,
  ]);
  return flow;
}

function build_baseline_step(): Step<unknown, number> {
  return step('measure_baseline', async (_input: unknown, ctx) => {
    const brief = read_brief(ctx.state);
    const parent_content = await readFile(brief.metric.mutable_path, 'utf8');
    const score = await evaluate_candidate(
      brief.metric,
      parent_content,
      failure_score_for(brief.metric.direction),
    );
    if (!score.accepted) {
      throw new Error(
        `baseline: starter file failed ${String(score.stage_failed)} stage. Tail:\n${score.tail ?? '(no tail)'}`,
      );
    }
    ctx.trajectory.record({ kind: 'amplify.baseline', score: score.value });
    return score.value;
  });
}

function build_research_step(engine: Engine): Step<unknown, string> {
  return step('research', async (_input: unknown, ctx) => {
    const brief = read_brief(ctx.state);
    const mode = pick_mode();
    const summary = await gather_research(engine, brief, ctx, mode);
    await cache_research(brief.run_dir, summary);
    ctx.trajectory.record({ kind: 'amplify.research_done', mode, chars: summary.length });
    return summary;
  });
}

type RoundCtx = {
  readonly engine: Engine;
  readonly brief: Brief;
  readonly research: string;
  readonly candidates_per_round: number;
};

async function run_one_round(
  round_ctx: RoundCtx,
  round_n: number,
  parent_content: string,
  parent_score: number,
  lessons_text: string,
  ctx: RunContext,
): Promise<{ readonly winner: Candidate; readonly all: ReadonlyArray<Candidate> }> {
  const { engine, brief, research, candidates_per_round } = round_ctx;
  const failure_score = failure_score_for(brief.metric.direction);

  const members: Record<string, Step<undefined, CandidateSpec>> = {};
  for (let i = 0; i < candidates_per_round; i++) {
    const proposer_id = `r${String(round_n)}c${String(i)}`;
    members[proposer_id] = build_propose_step({
      engine,
      brief,
      parent_content,
      parent_score,
      lessons: lessons_text,
      research,
      proposer_id,
      round: round_n,
    });
  }

  const round_dir = join(brief.run_dir, `round-${String(round_n)}`);
  const candidates_by_id: Record<string, Candidate> = {};

  const score_step = ensemble<undefined, CandidateSpec>({
    members,
    score: async (spec, member_id) => {
      await archive_candidate(round_dir, spec);
      const score = await evaluate_candidate(brief.metric, spec.content, failure_score);
      const candidate: Candidate = { spec, score };
      candidates_by_id[member_id] = candidate;
      ctx.trajectory.record({
        kind: 'amplify.candidate',
        round: round_n,
        proposer_id: member_id,
        accepted: score.accepted,
        stage_failed: score.stage_failed ?? null,
        value: score.accepted ? score.value : null,
      });
      if (!score.accepted) return failure_score;
      return brief.metric.direction === 'minimize' ? -score.value : score.value;
    },
    select: 'max',
  });

  await score_step.run(undefined, ctx);
  const all = Object.values(candidates_by_id);

  let winner_id = '';
  let winner_score: number | undefined;
  for (const [id, cand] of Object.entries(candidates_by_id)) {
    if (!cand.score.accepted) continue;
    if (
      winner_score === undefined ||
      strictly_better(brief.metric.direction, cand.score.value, winner_score)
    ) {
      winner_id = id;
      winner_score = cand.score.value;
    }
  }
  if (winner_id === '' || winner_score === undefined) {
    const first = all[0];
    if (first === undefined) throw new Error('round: no candidates produced');
    return { winner: first, all };
  }
  const winner = candidates_by_id[winner_id];
  if (winner === undefined) throw new Error('round: winner not found in candidates map');
  return { winner, all };
}

function build_round_loop_step(config: LoopConfig): Step<unknown, undefined> {
  const { engine, candidates_per_round, budget: budget_config } = config;
  return step('amplify_rounds', async (_input: unknown, ctx) => {
    const brief = read_brief(ctx.state);
    const baseline = read_baseline(ctx.state);
    const research = read_research(ctx.state);

    const budget = make_budget(budget_config);
    const lessons = make_lessons(LESSONS_CAPACITY);
    let parent_content = await readFile(brief.metric.mutable_path, 'utf8');
    let parent_score = baseline;
    const round_ctx: RoundCtx = { engine, brief, research, candidates_per_round };

    while (!budget.exhausted() && !budget.plateau()) {
      const round_n = budget.next_round();
      const { winner, all } = await run_one_round(
        round_ctx,
        round_n,
        parent_content,
        parent_score,
        lessons.format(),
        ctx,
      );

      const accepted =
        winner.score.accepted &&
        strictly_better(brief.metric.direction, winner.score.value, parent_score);

      ctx.trajectory.record({
        kind: 'amplify.round',
        round: round_n,
        winner_id: winner.spec.proposer_id,
        winner_value: winner.score.accepted ? winner.score.value : null,
        parent_score,
        accepted,
        candidates: all.length,
        budget: budget.state(),
      });

      if (accepted) {
        parent_content = winner.spec.content;
        parent_score = winner.score.value;
        await commit_parent(brief.metric.mutable_path, parent_content);
        budget.note_progress();
      } else {
        budget.note_no_progress();
        for (const c of all) {
          if (!c.score.accepted) {
            lessons.append({
              round: round_n,
              proposer_id: c.spec.proposer_id,
              stage_failed: c.score.stage_failed ?? 'no_improvement',
              summary: summarize_candidate(c),
            });
          }
        }
      }
    }

    ctx.trajectory.record({
      kind: 'amplify.done',
      final_score: parent_score,
      baseline,
      improvement_pct:
        baseline === 0
          ? 0
          : ((parent_score - baseline) / Math.abs(baseline)) *
            (brief.metric.direction === 'minimize' ? -100 : 100),
      budget: budget.state(),
    });
    return undefined;
  });
}
