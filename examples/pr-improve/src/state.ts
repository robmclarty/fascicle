/**
 * Build-review loop state: the carry-state record and its pure transitions.
 *
 * The chain-based flow threads everything else through typed bindings, so
 * this file holds only what the loop iterates on: round count, the previous
 * reviewer feedback, and the last handoff/verdict pair the shell reads off
 * the final state.
 */

import type { BuildVerdict, Handoff } from './types.js'

export type LoopState = {
  readonly round: number
  readonly previous_feedback: string | null
  readonly last_handoff: Handoff | null
  readonly last_verdict: BuildVerdict | null
}

export const initial_loop_state: LoopState = {
  round: 0,
  previous_feedback: null,
  last_handoff: null,
  last_verdict: null,
}

export function next_loop_state(
  prev: LoopState,
  handoff: Handoff,
  verdict: BuildVerdict,
): LoopState {
  return {
    round: prev.round + 1,
    previous_feedback: verdict.kind === 'needs-changes' ? verdict.feedback : null,
    last_handoff: handoff,
    last_verdict: verdict,
  }
}

export function loop_converged(state: LoopState): boolean {
  return state.last_verdict?.kind === 'pass'
}
