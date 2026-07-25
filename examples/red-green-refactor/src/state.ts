/**
 * Scope-state keys and typed readers: the one place `as` appears on scope
 * state, kept adjacent to the keys so a stash/read mismatch is visible in a
 * single screenful.
 */

import type { Behavior, Snapshot } from './types.js'

export const K = {
  BEHAVIOR: 'behavior',
  BEFORE_RED: 'snapshot_before_red',
  AFTER_RED: 'snapshot_after_red',
} as const

export function read_behavior(state: { [k: string]: unknown }): Behavior {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.BEHAVIOR] as Behavior
}

export function read_before_red(state: { [k: string]: unknown }): Snapshot {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.BEFORE_RED] as Snapshot
}

export function read_after_red(state: { [k: string]: unknown }): Snapshot {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[K.AFTER_RED] as Snapshot
}
