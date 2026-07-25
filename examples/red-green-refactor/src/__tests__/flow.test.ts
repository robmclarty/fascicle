/**
 * End-to-end flow tests through the real `run()` with a stub engine and
 * scripted ports. No subprocess, no network, no toy test suite running inside
 * this one: the oracle and the snapshotter are injected, so each test scripts
 * a phase sequence and asserts the topology reacts correctly.
 */

import { run } from 'fascicle'
import { describe, expect, it } from 'vitest'

import { make_stub_engine } from '../engine.js'
import { build_flow, GREEN_MAX_ROUNDS, type FlowEnv } from '../flow.js'
import type { Behavior, FileEntry, Snapshot, TestVerdict } from '../types.js'

const BEHAVIOR: Behavior = { id: 'add_two_positives', description: '`add(a, b)` sums two positives.' }
const MODELS = { coder: 'stub' }

const TEST_PATH = 'toy/src/calculator.test.ts'

function snap(content: string, test_count: number): Snapshot {
  const entry: FileEntry = { content, test_count }
  return new Map([[TEST_PATH, entry]])
}

function verdict(passed: boolean): TestVerdict {
  return { passed, exit_code: passed ? 0 : 1, tail: passed ? 'ok' : 'FAIL calculator.test.ts' }
}

/**
 * Build a FlowEnv that returns the given verdicts and snapshots in order,
 * repeating the last entry once the script runs out.
 */
function scripted_env(verdicts: ReadonlyArray<TestVerdict>, snapshots: ReadonlyArray<Snapshot>): FlowEnv {
  let v = 0
  let s = 0
  return {
    oracle: async () => verdicts[Math.min(v++, verdicts.length - 1)] ?? verdict(true),
    snapshot: async () => snapshots[Math.min(s++, snapshots.length - 1)] ?? snap('', 0),
  }
}

// One test added during RED, then frozen for the rest of the cycle.
const BEFORE = snap('it("a", () => {})', 1)
const AFTER = snap('it("a", () => {})\nit("b", () => {})', 2)

describe('red-green-refactor flow', () => {
  it('completes a cycle when RED fails, GREEN passes, and REFACTOR stays green', async () => {
    const env = scripted_env(
      [verdict(false), verdict(true), verdict(true)],
      [BEFORE, AFTER, AFTER, AFTER],
    )
    await expect(run(build_flow(make_stub_engine(), MODELS, env), BEHAVIOR)).resolves.toBeUndefined()
  })

  it('fails RED when the new test does not actually fail', async () => {
    const env = scripted_env([verdict(true)], [BEFORE, AFTER])
    await expect(run(build_flow(make_stub_engine(), MODELS, env), BEHAVIOR)).rejects.toThrow(
      /RED failed: vitest passed/,
    )
  })

  it('fails RED when no new test was added', async () => {
    const env = scripted_env([verdict(false)], [BEFORE, BEFORE])
    await expect(run(build_flow(make_stub_engine(), MODELS, env), BEHAVIOR)).rejects.toThrow(
      /no new test was added/,
    )
  })

  it('fails RED when more than one test was added', async () => {
    const splatted = snap('it("a", () => {})\nit("b", () => {})\nit("c", () => {})', 3)
    const env = scripted_env([verdict(false)], [BEFORE, splatted])
    await expect(run(build_flow(make_stub_engine(), MODELS, env), BEHAVIOR)).rejects.toThrow(
      /expected exactly one new test, got 2/,
    )
  })

  it('gives GREEN bounded retries and fails the cycle when it never converges', async () => {
    const env = scripted_env([verdict(false)], [BEFORE, AFTER])
    await expect(run(build_flow(make_stub_engine(), MODELS, env), BEHAVIOR)).rejects.toThrow(
      new RegExp(`GREEN did not converge in ${String(GREEN_MAX_ROUNDS)} rounds`),
    )
  })

  it('rejects a GREEN that edited the test file instead of the implementation', async () => {
    const edited = snap('it("a", () => { expect(true).toBe(true) })\nit("b", () => {})', 2)
    const env = scripted_env([verdict(false), verdict(true)], [BEFORE, AFTER, edited])
    await expect(run(build_flow(make_stub_engine(), MODELS, env), BEHAVIOR)).rejects.toThrow(
      /GREEN backstop: test file .* was modified/,
    )
  })

  it('rejects a REFACTOR that broke the tests', async () => {
    const env = scripted_env(
      [verdict(false), verdict(true), verdict(false)],
      [BEFORE, AFTER, AFTER, AFTER],
    )
    await expect(run(build_flow(make_stub_engine(), MODELS, env), BEHAVIOR)).rejects.toThrow(
      /REFACTOR broke tests/,
    )
  })
})
