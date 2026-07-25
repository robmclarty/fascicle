/**
 * Pure round arithmetic: seed the loop, open a round, and settle one.
 *
 * `decide_round` is where "did this round improve anything" is answered. It
 * returns the next carry-state plus the decision, and writes nothing — the
 * flow branches on `accepted` and performs the file commit, so the decision
 * stays testable and visible in the trajectory.
 */

import { initial_budget, note_no_progress, note_progress, open_round } from './budget.js'
import { append_lessons } from './lessons.js'
import type {
  Brief,
  BudgetConfig,
  Candidate,
  Direction,
  Lesson,
  ProposerInput,
  RoundOutcome,
  RoundState,
  RunSummary,
} from './types.js'

const EPSILON = 0.001

function strictly_better(direction: Direction, a: number, b: number): boolean {
  return direction === 'minimize' ? a < b - EPSILON : a > b + EPSILON
}

export function initial_round_state(
  parent_content: string,
  baseline: number,
  config: BudgetConfig,
  started_at: number,
): RoundState {
  return {
    round: 0,
    parent_content,
    parent_score: baseline,
    baseline,
    lessons: [],
    budget: initial_budget(config, started_at),
    history: [],
  }
}

/** Advance the round counter and the budget's round tally. */
export function begin_round(state: RoundState): RoundState {
  return { ...state, round: state.round + 1, budget: open_round(state.budget) }
}

/**
 * Fan out the per-proposer inputs for one round.
 *
 * Proposer ids encode round and index so a trajectory span, an archived
 * candidate file, and a lesson all refer to the same attempt.
 */
export function build_proposer_inputs(
  brief: Brief,
  research: string,
  state: RoundState,
  candidates_per_round: number,
): ReadonlyArray<ProposerInput> {
  return Array.from({ length: candidates_per_round }, (_unused, i) => ({
    brief,
    research,
    round: state.round,
    proposer_id: `r${String(state.round)}c${String(i)}`,
    parent_content: state.parent_content,
    parent_score: state.parent_score,
    lessons: state.lessons,
  }))
}

function summarize_candidate(c: Candidate): string {
  if (c.score.accepted) {
    return `score=${String(c.score.value)}; rationale: ${c.spec.rationale}`
  }
  return `failed at ${String(c.score.stage_failed)}; rationale: ${c.spec.rationale}`
}

/**
 * Pick the round's winner: the accepted candidate with the best score.
 *
 * Falls back to the first candidate when none survived the gate, so the round
 * still has something to report; `accepted` is what decides whether the winner
 * actually becomes the next parent.
 */
function pick_winner(direction: Direction, candidates: ReadonlyArray<Candidate>): Candidate | undefined {
  let winner: Candidate | undefined
  for (const c of candidates) {
    if (!c.score.accepted) continue
    if (winner === undefined || strictly_better(direction, c.score.value, winner.score.value)) {
      winner = c
    }
  }
  return winner ?? candidates[0]
}

export function decide_round(
  brief: Brief,
  state: RoundState,
  candidates: ReadonlyArray<Candidate>,
): RoundOutcome {
  const winner = pick_winner(brief.metric.direction, candidates)
  if (winner === undefined) throw new Error('round: no candidates produced')

  const accepted =
    winner.score.accepted &&
    strictly_better(brief.metric.direction, winner.score.value, state.parent_score)

  const record = {
    round: state.round,
    winner_id: winner.spec.proposer_id,
    winner_value: winner.score.accepted ? winner.score.value : null,
    parent_score: state.parent_score,
    accepted,
    candidates: candidates.length,
  }

  if (accepted) {
    return {
      accepted,
      record,
      next_state: {
        ...state,
        parent_content: winner.spec.content,
        parent_score: winner.score.value,
        budget: note_progress(state.budget),
        history: [...state.history, record],
      },
    }
  }

  const new_lessons: ReadonlyArray<Lesson> = candidates
    .filter((c) => !c.score.accepted)
    .map((c) => ({
      round: state.round,
      proposer_id: c.spec.proposer_id,
      stage_failed: c.score.stage_failed ?? 'no_improvement',
      summary: summarize_candidate(c),
    }))

  return {
    accepted,
    record,
    next_state: {
      ...state,
      lessons: append_lessons(state.lessons, new_lessons),
      budget: note_no_progress(state.budget),
      history: [...state.history, record],
    },
  }
}

export function summarize_run(
  state: RoundState,
  direction: Direction,
  stopped_by: RunSummary['stopped_by'],
): RunSummary {
  const { baseline, parent_score } = state
  return {
    baseline,
    final_score: parent_score,
    improvement_pct:
      baseline === 0
        ? 0
        : ((parent_score - baseline) / Math.abs(baseline)) * (direction === 'minimize' ? -100 : 100),
    rounds_used: state.budget.rounds_used,
    stopped_by,
    history: state.history,
  }
}
