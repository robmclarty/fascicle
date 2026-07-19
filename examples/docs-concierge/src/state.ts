/**
 * Scope-state keys and typed readers: the one place `as` appears on scope
 * state, kept adjacent to the keys so a stash/read mismatch is visible in a
 * single screenful.
 */

import type { Assessment, Passage } from './types.js'

export const K = {
  QUESTION: 'question',
  PASSAGES: 'passages',
  ASSESSMENT: 'assessment',
} as const

export function read_question(state: { [k: string]: unknown }): string {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.QUESTION] as string
}

export function read_passages(state: { [k: string]: unknown }): ReadonlyArray<Passage> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.PASSAGES] as ReadonlyArray<Passage>
}

export function read_assessment(state: { [k: string]: unknown }): Assessment {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.ASSESSMENT] as Assessment
}
