/**
 * Scope state keys + loop state + pure state-transition helpers.
 *
 * The keys in `K` are the only string identifiers the flow needs to share
 * between stash sites and use sites. Reader functions wrap unsafe state
 * lookups in one place so flow.ts never sees `as` casts.
 */

import type { LoopResult } from '@repo/fascicle'

import type { BuildVerdict, Handoff, PRContext, PragmatistOutput, Suggestion } from './types.js'

export const K = {
  PR: 'pr',
  SUGGESTIONS: 'suggestions',
  SPEC: 'spec',
  LOOP_INPUT: 'loop_input',
  HANDOFF: 'handoff',
  VERDICT: 'verdict',
  LOOP_RESULT: 'loop_result',
} as const

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

// Reader helpers: one place where the unsafe assertions live so flow.ts stays clean.

export function read_pr(state: { [k: string]: unknown }): PRContext {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.PR] as PRContext
}

export function read_suggestions(state: { [k: string]: unknown }): ReadonlyArray<Suggestion> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.SUGGESTIONS] as ReadonlyArray<Suggestion>
}

export function read_spec(state: { [k: string]: unknown }): PragmatistOutput {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.SPEC] as PragmatistOutput
}

export function read_loop_input(state: { [k: string]: unknown }): LoopState {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.LOOP_INPUT] as LoopState
}

export function read_handoff(state: { [k: string]: unknown }): Handoff {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.HANDOFF] as Handoff
}

export function read_verdict(state: { [k: string]: unknown }): BuildVerdict {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.VERDICT] as BuildVerdict
}

export function read_loop_result(state: { [k: string]: unknown }): LoopResult<LoopState> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.LOOP_RESULT] as LoopResult<LoopState>
}
