/**
 * Scope-state keys and typed readers.
 *
 * Scope state is a string-keyed map of `unknown`; the readers here are the
 * only place an `as` cast appears on it, so flow.ts stays cast-free. Keys and
 * readers sit adjacent in one screenful so a stash/read mismatch is visible.
 */

import type { Assessment, DiffFile, ScreenResult, Signal, TriageInput } from './types.js'

export const K = {
  INPUT: 'input',
  FILES: 'files',
  SIGNALS: 'signals',
  SCREENED: 'screened',
  ASSESSMENT: 'assessment',
} as const

export function read_input(state: { [k: string]: unknown }): TriageInput {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.INPUT] as TriageInput
}

export function read_files(state: { [k: string]: unknown }): ReadonlyArray<DiffFile> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.FILES] as ReadonlyArray<DiffFile>
}

export function read_signals(state: { [k: string]: unknown }): ReadonlyArray<Signal> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.SIGNALS] as ReadonlyArray<Signal>
}

export function read_screened(state: { [k: string]: unknown }): ScreenResult {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.SCREENED] as ScreenResult
}

export function read_assessment(state: { [k: string]: unknown }): Assessment {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.ASSESSMENT] as Assessment
}
