/**
 * red-green-refactor flow: pure fascicle composition.
 *
 * Read top-to-bottom and you see the agent topology:
 *
 *   timeout(10 min)
 *     └ scope
 *         ├ stash BEHAVIOR     ← the behavior to drive in
 *         ├ stash BEFORE_RED   ← snapshot the toy's test files
 *         ├ red_phase      ─ ask → run tests → assert red → snapshot → assert one test added
 *         ├ green_phase    ─ adversarial(build = ask → run tests, accept = passed)
 *         │                  → assert converged → assert tests unchanged
 *         └ refactor_phase ─ ask → run tests → assert still green → assert tests unchanged
 *
 * RED is a one-shot guarded by two assertions: vitest must go red, AND the
 * snapshot diff must show exactly one new test definition. GREEN is an
 * `adversarial` loop bounded at four rounds. REFACTOR may not touch a test
 * file, which the post-phase snapshot comparison enforces.
 *
 * The test oracle and the snapshotter arrive as ports on `FlowEnv`, so the
 * flow never spawns a process itself and a test can inject scripted phases.
 */

import {
  adversarial,
  scope,
  sequence,
  stash,
  step,
  timeout,
  use,
  type AdversarialBuildInput,
  type AdversarialCritiqueResult,
  type AdversarialResult,
  type Engine,
  type GenerateResult,
  type Step,
} from 'fascicle'

import { assert_one_test_added, assert_tests_unchanged } from './backstop.js'
import { format_green_message, format_red_message, format_refactor_message } from './messages.js'
import type { Snapshotter } from './services/snapshot.js'
import type { TestOracle } from './services/vitest.js'
import { K, read_after_red, read_before_red, read_behavior } from './state.js'
import { make_coder_call } from './stages/coder.js'
import type { Behavior, FlowModels, TestVerdict } from './types.js'

const PER_BEHAVIOR_TIMEOUT_MS = 10 * 60 * 1000
export const GREEN_MAX_ROUNDS = 4

const VERDICT_TAIL_LINES = 20

export type FlowEnv = {
  readonly oracle: TestOracle
  readonly snapshot: Snapshotter
}

function verdict_tail(tail: string): string {
  return tail.split('\n').slice(-VERDICT_TAIL_LINES).join('\n')
}

export function build_flow(
  engine: Engine,
  models: FlowModels,
  env: FlowEnv,
): Step<Behavior, undefined> {
  const ask = make_coder_call(engine, models.coder)
  const discard = step('discard_generate_result', (_: GenerateResult) => undefined)
  const run_tests = step('run_tests', (_input: unknown, ctx) => env.oracle(ctx.abort))
  const take_snapshot = step('take_snapshot', () => env.snapshot())

  const red_phase: Step<unknown, undefined> = sequence([
    use([K.BEHAVIOR], (s) => format_red_message(read_behavior(s))),
    ask,
    discard,
    run_tests,
    step('assert_red', (verdict: TestVerdict) => {
      if (verdict.passed) {
        throw new Error(`RED failed: vitest passed but should have failed.\n${verdict_tail(verdict.tail)}`)
      }
      return undefined
    }),
    stash(K.AFTER_RED, take_snapshot),
    use([K.BEFORE_RED, K.AFTER_RED], (s) => {
      assert_one_test_added(read_before_red(s), read_after_red(s))
      return undefined
    }),
  ])

  const green_build: Step<AdversarialBuildInput<Behavior, TestVerdict>, TestVerdict> = sequence([
    step('format_green_message', (i: AdversarialBuildInput<Behavior, TestVerdict>) =>
      format_green_message(i.input, i.prior),
    ),
    ask,
    discard,
    run_tests,
  ])

  const green_loop = adversarial<Behavior, TestVerdict>({
    build: green_build,
    critique: step('green_verdict', (v: TestVerdict) => ({
      verdict: v.passed ? ('pass' as const) : ('fail' as const),
      notes: v.tail,
    })),
    accept: (c: AdversarialCritiqueResult) => c['verdict'] === 'pass',
    max_rounds: GREEN_MAX_ROUNDS,
  })

  const green_phase: Step<unknown, undefined> = sequence([
    use([K.BEHAVIOR], (s) => read_behavior(s)),
    green_loop,
    step('assert_green_converged', (r: AdversarialResult<TestVerdict>) => {
      if (!r.converged) {
        throw new Error(
          `GREEN did not converge in ${String(r.rounds)} rounds.\n${verdict_tail(r.candidate.tail)}`,
        )
      }
      return undefined
    }),
    assert_tests_frozen(env, 'GREEN'),
  ])

  const refactor_phase: Step<unknown, undefined> = sequence([
    use([K.BEHAVIOR], (s) => format_refactor_message(read_behavior(s))),
    ask,
    discard,
    run_tests,
    step('assert_still_green', (verdict: TestVerdict) => {
      if (!verdict.passed) {
        throw new Error(`REFACTOR broke tests:\n${verdict_tail(verdict.tail)}`)
      }
      return undefined
    }),
    assert_tests_frozen(env, 'REFACTOR'),
  ])

  const cycle: Step<unknown, undefined> = scope([
    stash(K.BEHAVIOR, step('init_behavior', (b: Behavior) => b)),
    stash(K.BEFORE_RED, take_snapshot),
    red_phase,
    green_phase,
    refactor_phase,
    step('cycle_done', () => undefined),
  ])

  return timeout(cycle, PER_BEHAVIOR_TIMEOUT_MS)
}

/**
 * Re-snapshot the toy's test files and assert none changed during `phase`.
 *
 * Every phase after RED compares against the post-RED snapshot, so the one
 * test RED added is the only test that may exist for this behavior and no
 * later phase can make a failure go away by editing it.
 */
function assert_tests_frozen(env: FlowEnv, phase: string): Step<unknown, undefined> {
  return use([K.AFTER_RED], async (s) => {
    const now = await env.snapshot()
    assert_tests_unchanged(read_after_red(s), now, phase)
    return undefined
  })
}
