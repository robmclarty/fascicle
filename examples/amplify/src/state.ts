/**
 * Scope-state keys and typed readers: the one place `as` appears on scope
 * state, kept adjacent to the keys so a stash/read mismatch is visible in a
 * single screenful.
 */

import type { Brief, Candidate, ProposerInput, RoundState } from './types.js'

export const K = {
  BRIEF: 'brief',
  BASELINE: 'baseline',
  RESEARCH: 'research',
  ROUND: 'round',
  CANDIDATES: 'candidates',
  PROPOSER: 'proposer',
} as const

export function read_brief(state: { [k: string]: unknown }): Brief {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.BRIEF] as Brief
}

export function read_baseline(state: { [k: string]: unknown }): number {
  const v = state[K.BASELINE]
  if (typeof v !== 'number') throw new Error(`scope state key "${K.BASELINE}" is not a number`)
  return v
}

export function read_research(state: { [k: string]: unknown }): string {
  const v = state[K.RESEARCH]
  if (typeof v !== 'string') throw new Error(`scope state key "${K.RESEARCH}" is not a string`)
  return v
}

export function read_round(state: { [k: string]: unknown }): RoundState {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.ROUND] as RoundState
}

export function read_candidates(state: { [k: string]: unknown }): ReadonlyArray<Candidate> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.CANDIDATES] as ReadonlyArray<Candidate>
}

export function read_proposer(state: { [k: string]: unknown }): ProposerInput {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.PROPOSER] as ProposerInput
}
