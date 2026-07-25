/**
 * Triple-OR stop condition: max iterations, wall-clock, plateau.
 *
 * Any one alone fails: a max-iterations cap can let a stuck loop burn 6
 * hours; a wall-clock alone hits the limit but says nothing about whether
 * progress was being made; a plateau alone runs forever if the model keeps
 * producing tiny noise-level wins. All three together are the OpenEvolve /
 * AlphaEvolve / Karpathy autoresearch pattern.
 *
 * Pure functions over an immutable `BudgetState`, which rides inside the
 * loop's carry-state. `now` is a parameter rather than a `Date.now()` call so
 * the wall-clock rule is testable without waiting for a clock.
 */

import type { BudgetConfig, BudgetState } from './types.js'

export function initial_budget(config: BudgetConfig, started_at: number): BudgetState {
  return {
    rounds_used: 0,
    rounds_since_progress: 0,
    started_at,
    max_rounds: config.max_rounds,
    max_wallclock_ms: config.max_wallclock_ms,
    patience: config.patience,
  }
}

/** Count a round as started. */
export function open_round(state: BudgetState): BudgetState {
  return { ...state, rounds_used: state.rounds_used + 1 }
}

export function note_progress(state: BudgetState): BudgetState {
  return { ...state, rounds_since_progress: 0 }
}

export function note_no_progress(state: BudgetState): BudgetState {
  return { ...state, rounds_since_progress: state.rounds_since_progress + 1 }
}

export function budget_exhausted(state: BudgetState, now: number): boolean {
  return state.rounds_used >= state.max_rounds || now - state.started_at >= state.max_wallclock_ms
}

export function budget_plateau(state: BudgetState): boolean {
  return state.rounds_since_progress >= state.patience
}

/**
 * Why the loop should stop, or `undefined` to keep going.
 *
 * Returned as a reason rather than a boolean so the run summary can report
 * which of the three rules actually fired.
 */
export function stop_reason(
  state: BudgetState,
  now: number,
): 'max_rounds' | 'budget' | 'plateau' | undefined {
  if (budget_plateau(state)) return 'plateau'
  if (state.rounds_used >= state.max_rounds) return 'max_rounds'
  if (now - state.started_at >= state.max_wallclock_ms) return 'budget'
  return undefined
}
