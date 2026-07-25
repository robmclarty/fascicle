/**
 * Structural backstops that the agent's prompt cannot lie its way past.
 *
 * - `assert_one_test_added` compares two snapshots and throws unless exactly
 *   one new test definition appeared (and no existing tests were removed).
 * - `assert_tests_unchanged` throws if any byte of any test file changed
 *   between two snapshots — used after GREEN and REFACTOR to keep the agent
 *   from "fixing" failures by editing the test.
 *
 * Pure functions over snapshots. Taking the snapshots is IO and lives in
 * `services/snapshot.ts`, which keeps these assertions testable with literals.
 */

import type { Snapshot } from './types.js'

function total_tests(snap: Snapshot): number {
  let n = 0
  for (const e of snap.values()) n += e.test_count
  return n
}

export function assert_one_test_added(before: Snapshot, after: Snapshot): void {
  const before_total = total_tests(before)
  const after_total = total_tests(after)
  const delta = after_total - before_total

  if (delta === 0) {
    throw new Error('RED backstop: no new test was added.')
  }
  if (delta < 0) {
    throw new Error(
      `RED backstop: tests were removed (before=${String(before_total)}, after=${String(after_total)}).`,
    )
  }
  if (delta > 1) {
    throw new Error(
      `RED backstop: expected exactly one new test, got ${String(delta)}. Splatting tests is not allowed.`,
    )
  }

  for (const [path, before_entry] of before) {
    const after_entry = after.get(path)
    if (after_entry === undefined) continue
    if (after_entry.test_count < before_entry.test_count) {
      throw new Error(
        `RED backstop: tests were removed from ${path} (${String(before_entry.test_count)} -> ${String(after_entry.test_count)}).`,
      )
    }
  }
}

export function assert_tests_unchanged(before: Snapshot, after: Snapshot, phase: string): void {
  for (const [path, before_entry] of before) {
    const after_entry = after.get(path)
    if (after_entry === undefined) {
      throw new Error(`${phase} backstop: test file ${path} was deleted.`)
    }
    if (after_entry.content !== before_entry.content) {
      throw new Error(`${phase} backstop: test file ${path} was modified. Tests must be frozen during ${phase}.`)
    }
  }
  for (const path of after.keys()) {
    if (!before.has(path)) {
      throw new Error(`${phase} backstop: a new test file ${path} appeared. Tests must be frozen during ${phase}.`)
    }
  }
}
